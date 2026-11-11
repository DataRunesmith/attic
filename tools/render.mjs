#!/usr/bin/env node
// Build a complete render in isolation, then atomically replace only owned output.
import {
  closeSync, cpSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseEnv } from "./env.mjs";

const [valuesFile, outArg, ...options] = process.argv.slice(2);
const overlayArg = options.find((arg) => arg !== "--build");
const buildOutput = options.includes("--build");
if (!valuesFile || !outArg) {
  console.error("usage: node tools/render.mjs <values.env | -> <out-dir> [overlay-dir] [--build]");
  process.exit(2);
}

const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const SKIP = new Set([
  "node_modules", ".wrangler", "dist", "build", ".dev.vars", ".git", ".github",
  ".cloudflare-build", "coverage", "tests", "docker", "docs", "tools", ".cache",
]);
const TEXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".html", ".css", ".txt", ".xml", ".json",
  ".jsonc", ".webmanifest", ".toml", ".sh", ".py", ".sql", ".md", ".svg", "",
]);
const MARKER = ".attic-render-output";

/** Test path containment using path segments rather than string prefixes. */
function isInside(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

/** Resolve an output path through its nearest existing real filesystem ancestor. */
function canonicalTarget(path) {
  let current = resolve(path);
  const tail = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Cannot resolve output path.");
    tail.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}

/** Exclude environment files, credentials, and private-key material from renders. */
function isEnvFile(path) {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.") || name === ".envrc" ||
    name === ".dev.vars" || name.startsWith(".dev.vars.") || name.endsWith(".env") ||
    name === ".cloudflare.env" || name.startsWith(".cloudflare.env.") ||
    [".npmrc", ".netrc", ".pypirc", "credentials", "credentials.json"].includes(name) ||
    /(?:^|[-_.])(secret|secrets|credentials?)(?:[-_.]|$)/i.test(name) ||
    /^(?:id_(?:rsa|ed25519|ecdsa|dsa)(?:$|[._-].*)|identity|ssh_host_.+_key)$/i.test(name) ||
    /\.(?:pem|key|p8|p12|pfx|keystore)$/i.test(name);
}

const PRIVATE_KEY_HEADER = /-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-/i;

/** Copy a tree without following symlinks or including private-key material. */
function copyTree(from, to, include) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in copied trees: " + from);
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const child = join(from, name);
      if (include(child)) copyTree(child, join(to, name), include);
    }
  } else if (stat.isFile()) {
    const fd = openSync(from, "r");
    let header;
    try {
      const sample = Buffer.alloc(512);
      const count = readSync(fd, sample, 0, sample.length, 0);
      header = sample.toString("utf8", 0, count);
    } finally {
      closeSync(fd);
    }
    if (PRIVATE_KEY_HEADER.test(header)) return;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}

/** Refuse to replace paths unless they are regular directories marked by this renderer. */
function assertOwnedOutput(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Existing output path must be a renderer-owned directory.");
  const marker = join(path, MARKER);
  if (!existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink())
    throw new Error("Refusing to replace an existing directory not created by this renderer.");
}

const outRequested = resolve(outArg);
const parentRequested = dirname(outRequested);
mkdirSync(parentRequested, { recursive: true });
if (existsSync(outRequested) && lstatSync(outRequested).isSymbolicLink())
  throw new Error("Refusing to use a symlink as the output directory.");
const out = canonicalTarget(outRequested);
const parent = dirname(out);
if (out === source || isInside(out, source))
  throw new Error("Output directory cannot be the source directory or one of its parents.");

let overlay = null;
if (overlayArg) {
  const overlayRequested = resolve(overlayArg);
  if (!existsSync(overlayRequested) || lstatSync(overlayRequested).isSymbolicLink())
    throw new Error("Overlay directory must exist and cannot be a symlink.");
  overlay = realpathSync(overlayRequested);
  if (!lstatSync(overlay).isDirectory())
    throw new Error("Overlay path must be a directory.");
  if (isInside(source, overlay) || isInside(overlay, source) ||
      isInside(out, overlay) || isInside(overlay, out))
    throw new Error("Overlay, output and source directories must be separate.");
}

const declared = [...parseEnv(join(source, "cloudflare.example.env")).keys()];
const values = valuesFile === "-"
  ? new Map(declared.filter((name) => name in process.env)
      .map((name) => [name, String(process.env[name]).replace(/\\n/g, "\n")]))
  : parseEnv(resolve(valuesFile));
const optional = new Set(["CF_ACCESS_AUD"]);
for (const name of optional) if (!values.has(name)) values.set(name, "");
const missing = declared.filter((name) => !optional.has(name) && !values.has(name));
if (missing.length) {
  console.error((valuesFile === "-" ? "the environment" : valuesFile) +
    " is missing: " + missing.join(", "));
  process.exit(1);
}

const lockPath = out + ".lock";
let lockFd;
let stage = null;
let backup = null;
const deferSignal = () => {};
process.on("SIGINT", deferSignal);
process.on("SIGTERM", deferSignal);
try {
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const lockStat = lstatSync(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink())
      throw new Error("Render lock is not a regular file; inspect " + lockPath + ".");
    const ownerPid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isSafeInteger(ownerPid) || ownerPid < 2)
      throw new Error("Render lock has no valid owner PID; inspect " + lockPath + ".");
    let ownerAlive = true;
    try { process.kill(ownerPid, 0); }
    catch (probeError) {
      if (probeError.code === "ESRCH") ownerAlive = false;
      else if (probeError.code !== "EPERM") throw probeError;
    }
    if (ownerAlive)
      throw new Error("Another render (PID " + ownerPid + ") is active for " + out + ".");
    rmSync(lockPath);
    lockFd = openSync(lockPath, "wx", 0o600);
  }
  writeFileSync(lockFd, String(process.pid));
} catch (error) {
  process.off("SIGINT", deferSignal);
  process.off("SIGTERM", deferSignal);
  throw error;
}

try {
  // Recover an interrupted swap before starting a new render. Only directories
  // carrying our ownership marker are eligible for restoration or cleanup.
  const backupPrefix = basename(out) + ".backup-";
  const backups = readdirSync(parent)
    .filter((name) => name.startsWith(backupPrefix))
    .map((name) => join(parent, name))
    .filter((path) => existsSync(path))
    .sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
  if (!existsSync(out) && backups.length) {
    const restore = backups.shift();
    assertOwnedOutput(restore);
    renameSync(restore, out);
  }
  assertOwnedOutput(out);
  for (const staleBackup of backups) {
    assertOwnedOutput(staleBackup);
    rmSync(staleBackup, { recursive: true, force: true });
  }
  stage = mkdtempSync(join(parent, "." + basename(out) + ".stage-"));
  const includeSource = (path) => {
    const name = basename(path);
    if (path === lockPath || isInside(out, path) || isInside(stage, path) || isEnvFile(path))
      return false;
    if (name.startsWith(basename(out) + ".backup-") ||
        name.startsWith("." + basename(out) + ".stage-"))
      return false;
    return !relative(source, path).split(sep).some((part) => SKIP.has(part));
  };
  copyTree(source, stage, includeSource);
  if (overlay) copyTree(overlay, stage, (path) => !isEnvFile(path));

  writeFileSync(join(stage, MARKER), "Generated by tools/render.mjs. Safe to replace.\n",
    { mode: 0o600 });
  const modules = join(source, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, join(stage, "node_modules"), "dir");

  let replaced = 0;
  (function substitute(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { substitute(path); continue; }
      if (!entry.isFile() || (!TEXT.has(extname(entry.name)) && entry.name !== "_headers"))
        continue;
      const fd = openSync(path, "r+");
      try {
        if (fstatSync(fd).size > 5_000_000) continue;
        let text = readFileSync(fd, "utf8");
        const before = text;
        const extension = extname(entry.name).toLowerCase();
        for (const name of declared) {
          const token = "__" + name + "__";
          if (!text.includes(token)) continue;
          const value = String(values.get(name));
          const escaped = [".js", ".mjs", ".cjs", ".ts", ".json", ".jsonc", ".webmanifest"]
            .includes(extension)
            ? JSON.stringify(value).slice(1, -1)
            : [".html", ".svg", ".xml"].includes(extension)
              ? value.replace(/[&<>"']/g, (character) => ({
                  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
                })[character])
              : value;
          text = text.split(token).join(escaped);
        }
        const unresolved = text.match(/__[A-Z][A-Z0-9_]*__/g);
        if (unresolved)
          throw new Error(path + " contains unresolved placeholders: " + [...new Set(unresolved)].join(", "));
        if (entry.name === "wrangler.jsonc") {
          const config = JSON.parse(text);
          if (Array.isArray(config.routes))
            config.routes = config.routes.filter((route) => route.pattern);
          text = JSON.stringify(config, null, 2) + "\n";
        }
        if (text !== before) {
          const bytes = Buffer.from(text, "utf8");
          ftruncateSync(fd);
          for (let done = 0; done < bytes.length;)
            done += writeSync(fd, bytes, done, bytes.length - done, done);
          replaced++;
        }
      } finally {
        closeSync(fd);
      }
    }
  })(stage);

  if (buildOutput) {
    const result = spawnSync(process.execPath, ["build.mjs"], { cwd: stage, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error("Worker bundle build failed; previous rendered output was preserved.");
  }

  // Recheck immediately before moving the existing output. Never recursively delete it.
  assertOwnedOutput(out);
  if (existsSync(out)) {
    backup = out + ".backup-" + randomUUID();
    renameSync(out, backup);
    try {
      // A path could have been swapped between the check and rename. Verify
      // the moved directory before ever allowing it to be removed.
      assertOwnedOutput(backup);
    } catch (error) {
      renameSync(backup, out);
      backup = null;
      throw error;
    }
  }
  try {
    renameSync(stage, out);
    stage = null;
  } catch (error) {
    if (backup && existsSync(backup)) {
      renameSync(backup, out);
      backup = null;
    }
    throw error;
  }
  if (backup) {
    assertOwnedOutput(backup);
    rmSync(backup, { recursive: true, force: true });
    backup = null;
  }
  console.log("rendered into " + out + " (" + replaced + " files filled in)");
} finally {
  if (stage && existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  if (backup && existsSync(backup) && !existsSync(out)) renameSync(backup, out);
  if (lockFd !== undefined) closeSync(lockFd);
  rmSync(lockPath, { force: true });
  process.off("SIGINT", deferSignal);
  process.off("SIGTERM", deferSignal);
}

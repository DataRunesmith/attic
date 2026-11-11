#!/usr/bin/env node
// Renders a deployable copy of this repo with your own values.
//
//   node tools/render.mjs <values.env | -> <out-dir> [overlay-dir]
//
// The repo holds only placeholders (__NAME__). Every NAME listed in
// cloudflare.example.env must have a value in <values.env> (it may be empty);
// each __NAME__ in the copied text files is replaced with its value. With "-"
// the values are read from environment variables instead, e.g. the build
// variables of Cloudflare Workers Builds or a container's environment.
// Values may use \n for line breaks, or "@path" to read a file. Files in the
// optional overlay directory are copied on top (e.g. your own images). Routes
// whose pattern ends up empty are dropped from wrangler.jsonc. Deploy with
//   npx wrangler deploy --cwd <out-dir>   (politiker: --cwd <out-dir>/app)
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [valuesFile, outArg, overlayArg] = process.argv.slice(2);
if (!valuesFile || !outArg) {
  console.error("usage: node tools/render.mjs <values.env | -> <out-dir> [overlay-dir]");
  process.exit(2);
}

const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const allowedOutRoot = realpathSync(process.cwd());

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateCliPath(value, name) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be a non-empty path.`);
  if (value.includes("\\0")) throw new Error(`${name} must not contain NUL bytes.`);
  const normalized = value.replaceAll("\\\\", "/");
  if (normalized.split("/").includes(".."))
    throw new Error(`${name} must not contain parent-directory segments ("..").`);
}

validateCliPath(outArg, "out-dir");
if (overlayArg) validateCliPath(overlayArg, "overlay-dir");

const requestedOut = resolve(allowedOutRoot, outArg);
if (!isWithin(allowedOutRoot, requestedOut))
  throw new Error("Output path must stay within the current working directory.");
mkdirSync(dirname(requestedOut), { recursive: true });
const canonicalParent = realpathSync(dirname(requestedOut));
const out = resolve(canonicalParent, basename(requestedOut));
if (!isWithin(allowedOutRoot, out))
  throw new Error("Output path resolves outside the current working directory.");

let outInfo;
try {
  outInfo = lstatSync(out);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (outInfo?.isSymbolicLink()) throw new Error("Refusing to replace a symbolic-link output path.");
if (outInfo && !outInfo.isDirectory()) throw new Error("Output path exists and is not a directory.");
if (isWithin(out, source))
  throw new Error("Output path cannot be the source directory or one of its parent directories.");
if (isWithin(source, out)) {
  const outputRoot = relative(source, out).split(sep)[0];
  if (outputRoot !== "dist")
    throw new Error("An output directory inside the repository must be the dedicated generated directory dist.");
}

let overlay = null;
if (overlayArg) {
  const requestedOverlay = resolve(allowedOutRoot, overlayArg);
  if (!isWithin(allowedOutRoot, requestedOverlay))
    throw new Error("Overlay path must stay within the current working directory.");
  const overlayInfo = lstatSync(requestedOverlay);
  if (overlayInfo.isSymbolicLink() || !overlayInfo.isDirectory())
    throw new Error("Overlay path must be a real directory, not a symbolic link.");
  overlay = realpathSync(requestedOverlay);
  if (!isWithin(allowedOutRoot, overlay) || isWithin(out, overlay) || isWithin(overlay, out))
    throw new Error("Overlay and output directories must be separate paths inside the current working directory.");
}

const SKIP = new Set(["node_modules", ".wrangler", "dist", ".dev.vars", ".git", ".github"]);
const TEXT = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".html",
  ".css",
  ".txt",
  ".xml",
  ".json",
  ".jsonc",
  ".webmanifest",
  ".toml",
  ".sh",
  ".py",
  ".sql",
  ".md",
  ".svg",
  "",
]);

function parseEnv(file) {
  const values = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith("@"))
      value = readFileSync(resolve(dirname(file), value.slice(1)), "utf8").trimEnd();
    values.set(match[1], value.replace(/\\n/g, "\n"));
  }
  return values;
}

const declared = [...parseEnv(join(source, "cloudflare.example.env")).keys()];
const values =
  valuesFile === "-"
    ? new Map(
        declared
          .filter((name) => name in process.env)
          .map((name) => [name, process.env[name].replace(/\\n/g, "\n")]),
      )
    : parseEnv(valuesFile);
const missing = declared.filter((name) => !values.has(name));
if (missing.length) {
  console.error(
    `${valuesFile === "-" ? "the environment" : valuesFile} is missing: ${missing.join(", ")}`,
  );
  process.exit(1);
}

// Only a dedicated generated output directory (or a path outside the repo)
// may be replaced. The path and its parent have been canonicalized above.
rmSync(out, { recursive: true, force: true });
const keep = (path) => {
  const outRelative = relative(out, path);
  const isOutput = outRelative === "" ||
    (outRelative !== ".." && !outRelative.startsWith(`..${sep}`) && !isAbsolute(outRelative));
  const sourceRelative = relative(source, path);
  return !isOutput && !sourceRelative.split(sep).some((part) => SKIP.has(part));
};
for (const name of readdirSync(source)) {
  const path = join(source, name);
  if (keep(path))
    cpSync(path, join(out, name), {
      recursive: true,
      filter: (candidate) => keep(candidate) && !lstatSync(candidate).isSymbolicLink(),
    });
}
if (overlay) {
  cpSync(overlay, out, {
    recursive: true,
    filter: (path) => !lstatSync(path).isSymbolicLink(),
  });
}

// Dependencies stay in the repo; link them instead of copying.
(function linkModules(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      (SKIP.has(entry.name) && entry.name !== "node_modules") ||
      join(dir, entry.name) === out
    )
      continue;
    const path = join(dir, entry.name);
    if (entry.name === "node_modules") {
      symlinkSync(path, join(out, relative(source, path)));
    } else if (relative(source, path).split(sep).length < 3) {
      linkModules(path);
    }
  }
})(source);

let replaced = 0;
(function substitute(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      substitute(path);
      continue;
    }
    if (!TEXT.has(extname(entry.name)) && entry.name !== "_headers") continue;
    // Size check, read and write all go through one descriptor, so the file
    // cannot be swapped between them.
    const fd = openSync(path, "r+");
    try {
      const descriptorInfo = fstatSync(fd);
      const pathInfo = lstatSync(path);
      if (
        !descriptorInfo.isFile() ||
        !pathInfo.isFile() ||
        pathInfo.isSymbolicLink() ||
        descriptorInfo.dev !== pathInfo.dev ||
        descriptorInfo.ino !== pathInfo.ino ||
        descriptorInfo.size > 5_000_000
      ) continue;
      let text = readFileSync(fd, "utf8");
      const before = text;
      for (const name of declared) text = text.split(`__${name}__`).join(values.get(name));
      if (entry.name === "wrangler.jsonc") {
        text = text.replace(/\{\s*"pattern":\s*""[^}]*\},?\s*/g, "");
      }
      if (text !== before) {
        // writeSync may write less than asked, so loop until every byte is out.
        const bytes = Buffer.from(text, "utf8");
        ftruncateSync(fd);
        for (let done = 0; done < bytes.length;) {
          done += writeSync(fd, bytes, done, bytes.length - done, done);
        }
        replaced++;
      }
    } finally {
      closeSync(fd);
    }
  }
})(out);

console.log(`rendered into ${out} (${replaced} files filled in)`);

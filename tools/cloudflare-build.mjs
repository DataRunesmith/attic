#!/usr/bin/env node
// Render and build the Worker, then redirect Wrangler to the generated config.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseEnv } from "./env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localEnv = join(root, ".cloudflare.env");
const valuesFile = existsSync(localEnv) ? localEnv : "-";
const out = join(root, ".cloudflare-build");

const values = valuesFile === "-" ? process.env : Object.fromEntries(parseEnv(valuesFile));
const required = [
  "PUBLIC_HOST", "PUBLIC_ORIGIN", "GALLERY_BUCKET", "LEGACY_BUCKET",
  "SECRETS_STORE_ID", "CLOUDFLARE_ACCOUNT_ID",
];
const missing = required.filter((key) => !values[key]);
if (missing.length) throw new Error("Missing Cloudflare build values: " + missing.join(", "));
const bucketPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
for (const key of ["GALLERY_BUCKET", "LEGACY_BUCKET"])
  if (!bucketPattern.test(values[key])) throw new Error(key + " is not a valid R2 bucket name.");
if (values.GALLERY_BUCKET === values.LEGACY_BUCKET)
  throw new Error("GALLERY_BUCKET and LEGACY_BUCKET must be different.");
if (!/^[a-f0-9]{32}$/i.test(values.SECRETS_STORE_ID))
  throw new Error("SECRETS_STORE_ID must be a 32-character hexadecimal ID.");
if (!/^[a-f0-9]{32}$/i.test(values.CLOUDFLARE_ACCOUNT_ID))
  throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID.");
const hostLabels = values.PUBLIC_HOST.split(".");
if (values.PUBLIC_HOST.length > 253 || hostLabels.length < 2 ||
    hostLabels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
  throw new Error("PUBLIC_HOST must be a valid DNS hostname without a scheme or path.");
const publicUrl = new URL(values.PUBLIC_ORIGIN);
if (publicUrl.protocol !== "https:" || publicUrl.hostname !== values.PUBLIC_HOST ||
    publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" ||
    publicUrl.search || publicUrl.hash)
  throw new Error("PUBLIC_ORIGIN must be the HTTPS origin matching PUBLIC_HOST.");

/** Run a build subprocess and propagate spawn or non-zero exit failures. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(command + " " + args.join(" ") + " failed (" + result.status + ").");
}
run(process.execPath, [join(root, "tools", "render.mjs"), valuesFile, out, "--build"], root);

const configPath = join(out, "wrangler.jsonc");
const configText = readFileSync(configPath, "utf8");
const config = JSON.parse(configText);
const workerOutput = join(out, "dist", "worker.js");
if (!existsSync(workerOutput) || !lstatSync(workerOutput).isFile() || lstatSync(workerOutput).isSymbolicLink())
  throw new Error("Rendered Worker bundle is missing or not a regular file.");
if (config.name !== "attic" || config.main !== "dist/worker.js")
  throw new Error("Rendered Wrangler configuration has an unexpected Worker name or entrypoint.");
if (/__[A-Z][A-Z0-9_]*__/.test(configText))
  throw new Error("Rendered Wrangler configuration still contains unresolved placeholders.");
console.log("Cloudflare build prepared. Deploy with --config .cloudflare-build/wrangler.jsonc.");

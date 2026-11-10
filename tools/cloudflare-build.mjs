#!/usr/bin/env node
// Render and build the Worker, then redirect Wrangler to the generated config.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseEnv } from "./env.mjs";
import { validateBuildValues } from "../build-values.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localEnv = join(root, ".cloudflare.env");
const valuesFile = existsSync(localEnv) ? localEnv : "-";
const out = join(root, ".cloudflare-build");

const values = valuesFile === "-" ? process.env : Object.fromEntries(parseEnv(valuesFile));
validateBuildValues(values);

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

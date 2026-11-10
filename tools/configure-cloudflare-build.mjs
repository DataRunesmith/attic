#!/usr/bin/env node
// Configure the already-connected Workers Build using .cloudflare.env.
// Requires a user-scoped token with Workers Builds Configuration: Edit
// and Workers Scripts: Read.
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./env.mjs";
import { validateBuildValues } from "../build-values.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".cloudflare.env");
const values = Object.fromEntries(parseEnv(envPath));
const accountId = values.CLOUDFLARE_ACCOUNT_ID || "";
const token = values.CLOUDFLARE_API_TOKEN || "";
const workerName = values.WORKER_NAME || "attic";
if (!/^[a-f0-9]{32}$/i.test(accountId))
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID in .cloudflare.env.");
if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN in .cloudflare.env.");
if (workerName !== "attic")
  throw new Error("WORKER_NAME must match wrangler.jsonc (attic).");

// Validate every build input before making any remote configuration change.
validateBuildValues(values);

/** Call the Cloudflare API and reject both HTTP and API-level failures. */
async function api(path, options = {}) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    ...options,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) {
    const messages = (data.errors || []).map((x) => x.message).join("; ");
    throw new Error("Cloudflare API " + (options.method || "GET") + " " + path +
      " failed: " + (messages || response.status));
  }
  return data.result;
}
const scripts = [];
for (let page = 1; ; page++) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + accountId +
    "/workers/scripts?per_page=100&page=" + page, {
      headers: { authorization: "Bearer " + token, accept: "application/json" },
    });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) {
    const messages = (data.errors || []).map((x) => x.message).join("; ");
    throw new Error("Cloudflare API GET workers/scripts failed: " + (messages || response.status));
  }
  scripts.push(...data.result);
  if (!data.result_info || page >= data.result_info.total_pages) break;
}
const worker = scripts.find((item) => item.id === workerName);
if (!worker?.tag)
  throw new Error('Worker "' + workerName + '" was not found in account ' + accountId + ".");
const endpoint = "/accounts/" + accountId + "/builds/workers/" + encodeURIComponent(worker.tag);
const current = await api(endpoint);
if (!current?.git_repository)
  throw new Error("This Worker is not connected to GitHub Workers Builds yet. Connect it first.");

const buildKeys = [
  "PUBLIC_HOST", "PUBLIC_ORIGIN", "GALLERY_BUCKET", "LEGACY_BUCKET",
  "SECRETS_STORE_ID", "CLOUDFLARE_ACCOUNT_ID",
];
const environmentVariables = Object.fromEntries(
  buildKeys.map((key) => [key, { value: values[key], is_secret: false }]),
);
await api(endpoint, {
  method: "PATCH",
  body: JSON.stringify({
    production_settings: {
      build_command: "npm run build:cloudflare",
      deploy_command: "npx wrangler deploy --config .cloudflare-build/wrangler.jsonc",
      environment_variables: environmentVariables,
    },
    previews_enabled: false,
  }),
});
console.log('Configured Workers Builds for "' + workerName + '".');
console.log("Build command: npm run build:cloudflare");
console.log("Deploy command: npx wrangler deploy --config .cloudflare-build/wrangler.jsonc");
console.log("Preview builds: disabled.");

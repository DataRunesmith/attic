// Build the self-contained Worker that is deployed to Cloudflare: embeds public/
// as JSON, serves it through an in-memory ASSETS shim and injects validated vars.
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const publicRoot = resolve("public");
if (!lstatSync(publicRoot).isDirectory() || lstatSync(publicRoot).isSymbolicLink())
  throw new Error("public must be a regular directory.");
const manifestPath = join(publicRoot, "manifest.json");
if (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile())
  throw new Error("public/manifest.json must be a regular file.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest) || manifest.length > 100)
  throw new Error("public/manifest.json must contain at most 100 asset entries.");

const allowedTypes = new Set([
  "text/html; charset=utf-8",
  "text/css; charset=utf-8",
  "text/javascript; charset=utf-8",
]);
const seenRoutes = new Set();
let totalAssetBytes = 0;

/** Resolve a manifest asset strictly inside public without following symlinks. */
function readPublicAsset(file) {
  if (typeof file !== "string" || !file || file.includes("\\") ||
      file.startsWith("/") || file.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Manifest contains an unsafe asset path.");
  let current = publicRoot;
  for (const part of file.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Manifest assets cannot be symlinks: " + file);
    if (current !== resolve(publicRoot, file) && !stat.isDirectory())
      throw new Error("Manifest asset path contains a non-directory component: " + file);
    if (current === resolve(publicRoot, file) && !stat.isFile())
      throw new Error("Manifest asset must be a regular file: " + file);
  }
  const rel = relative(publicRoot, current);
  if (rel === ".." || rel.startsWith(".." + sep))
    throw new Error("Manifest asset escapes the public directory.");
  const stat = lstatSync(current);
  if (stat.size > 5_000_000) throw new Error("Manifest asset is larger than 5 MB: " + file);
  totalAssetBytes += stat.size;
  if (totalAssetBytes > 10_000_000) throw new Error("Embedded public assets exceed 10 MB.");
  return readFileSync(current, "utf8");
}

const files = Object.fromEntries(manifest.map((entry) => {
  if (!Array.isArray(entry) || entry.length !== 3)
    throw new Error("Each manifest entry must contain route, file, and content type.");
  const [route, file, type] = entry;
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") ||
      route.includes("\\") || /[?#\u0000-\u001f]/.test(route) ||
      route.split("/").some((part) => part === "." || part === "..") ||
      seenRoutes.has(route))
    throw new Error("Manifest contains an invalid or duplicate route.");
  if (!allowedTypes.has(type))
    throw new Error("Manifest contains an unsupported content type for " + route + ".");
  seenRoutes.add(route);
  return [route, [readPublicAsset(file), type]];
}));

const configText = readFileSync("wrangler.jsonc", "utf8");
const config = JSON.parse(configText);
const publicHost = config.routes?.find((route) => route.custom_domain === true)?.pattern;
const accountId = config.account_id;
const galleryBucket = config.r2_buckets?.find((binding) => binding.binding === "GALLERY_BUCKET")?.bucket_name;
const legacyBucket = config.r2_buckets?.find((binding) => binding.binding === "LEGACY_BUCKET")?.bucket_name;
const hostLabels = typeof publicHost === "string" ? publicHost.split(".") : [];
const bucketPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
if (hostLabels.length < 2 || publicHost.length > 253 ||
    hostLabels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/^[a-f0-9]{32}$/i.test(accountId || "") ||
    !bucketPattern.test(galleryBucket || "") || !bucketPattern.test(legacyBucket || ""))
  throw new Error("Rendered Wrangler configuration has an invalid domain, account ID, or R2 bucket.");

const sourceRoot = resolve("src");
const sourceRootStat = lstatSync(sourceRoot);
const workerSource = join(sourceRoot, "index.js");
const workerSourceStat = lstatSync(workerSource);
if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink() ||
    !workerSourceStat.isFile() || workerSourceStat.isSymbolicLink())
  throw new Error("src/index.js must be a regular file inside a regular src directory.");
let src = readFileSync(workerSource, "utf8");
const needle = "  async fetch(request, env, ctx) {\n";
if (src.split(needle).length !== 2)
  throw new Error("src/index.js must contain exactly one `async fetch(request, env, ctx)`");
const injectedValues = {
  PUBLIC_ORIGIN: "https://" + publicHost,
  CF_ACCESS_ACCOUNT_ID: accountId,
  LEGACY_BUCKET_NAME: legacyBucket,
  GALLERY_PREFIX: "gallery/",
};
const injectedCode = Object.entries(injectedValues)
  .map(([key, value]) => key + ": " + JSON.stringify(value))
  .join(", ");
src = src.replace(
  needle,
  () => needle + "    env = { ...env, ASSETS: { fetch: bundledAssetFetch }, " +
    injectedCode + " };\n",
);

const prefix = `// Self-contained Attic Worker: assets are embedded; no external CDN.
const bundledFiles = ${JSON.stringify(files)};
/** Serve a manifest-approved embedded asset from the Worker bundle. */
async function bundledAssetFetch(request) {
  const url = new URL(request.url);
  const asset = bundledFiles[url.pathname];
  if (!asset) return new Response('Sidan finns inte.', {status:404});
  return new Response(request.method === 'HEAD' ? null : asset[0], {status:200,headers:{'content-type':asset[1]}});
}
`;

const dist = resolve("dist");
if (existsSync(dist)) {
  const stat = lstatSync(dist);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("dist must be a regular directory.");
} else mkdirSync(dist);
const output = join(dist, "worker.js");
if (existsSync(output) && (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink()))
  throw new Error("dist/worker.js must be a regular file.");
const temporary = join(dist, ".worker-" + process.pid + "-" + randomUUID() + ".tmp");
try {
  writeFileSync(temporary, prefix + src, { flag: "wx", mode: 0o600 });
  renameSync(temporary, output);
} finally {
  rmSync(temporary, { force: true });
}

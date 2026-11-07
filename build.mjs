// Builds the self-contained Worker that is deployed to Cloudflare: embeds public/
// as JSON, serves it through an in-memory ASSETS shim and injects the production vars.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// __NAME__ placeholders are filled in by tools/render.mjs before deploy.
const ACCESS_AUD = "__CF_ACCESS_AUD__";

const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
const files = Object.fromEntries(
  manifest.map(([route, file, type]) => [route, [readFileSync(`public/${file}`, "utf8"), type]]),
);

let src = readFileSync("src/index.js", "utf8");
const needle = "  async fetch(request, env) {\n";
if (src.split(needle).length !== 2)
  throw new Error("src/index.js must contain exactly one `async fetch(request, env)`");
src = src.replace(
  needle,
  () =>
    needle +
    `    env = { ...env, ASSETS: { fetch: bundledAssetFetch }, CF_ACCESS_AUD: "${ACCESS_AUD}", ` +
    `CF_ACCESS_TEAM_DOMAIN: "__CF_ACCESS_TEAM_DOMAIN__", PUBLIC_ASSET_ORIGIN: "__PUBLIC_ORIGIN__/bilder", ` +
    `CF_ACCESS_ACCOUNT_ID: "__CLOUDFLARE_ACCOUNT_ID__", GALLERY_PREFIX: "gallery/" };\n`,
);

const prefix = `// Self-contained Attic Worker: assets are embedded; no external CDN.
const bundledFiles = ${JSON.stringify(files)};
async function bundledAssetFetch(request) {
  const url = new URL(request.url);
  const asset = bundledFiles[url.pathname];
  if (!asset) return new Response('Sidan finns inte.', {status:404});
  return new Response(request.method === 'HEAD' ? null : asset[0], {status:200,headers:{'content-type':asset[1]}});
}
`;

mkdirSync("dist", { recursive: true });
writeFileSync("dist/worker.js", prefix + src);

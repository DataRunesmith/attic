import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const buildScript = fileURLToPath(new URL("../build.mjs", import.meta.url));
const htmlType = "text/html; charset=utf-8";

/** Create the minimal source and public tree consumed by build.mjs. */
function fixture(manifest, root = mkdtempSync(join(tmpdir(), "attic-build-test-"))) {
  mkdirSync(join(root, "public"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({
    account_id: "a".repeat(32),
    routes: [{ pattern: "images.example.com", custom_domain: true }],
    r2_buckets: [
      { binding: "GALLERY_BUCKET", bucket_name: "gallery" },
      { binding: "LEGACY_BUCKET", bucket_name: "legacy" },
    ],
  }));
  writeFileSync(join(root, "public", "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "public", "index.html"), "<h1>safe</h1>");
  writeFileSync(
    join(root, "src", "index.js"),
    'export default {\n  async fetch(request, env, ctx) { return new Response("ok"); }\n};\n',
  );
  return root;
}

/** Run the real build script with a temporary directory as its working tree. */
function runBuild(root) {
  return spawnSync(process.execPath, [buildScript], {
    cwd: root,
    encoding: "utf8",
  });
}

test("build embeds only declared public assets", () => {
  const root = fixture([["/", "index.html", htmlType]]);
  try {
    const result = runBuild(root);
    assert.equal(result.status, 0, result.stderr);
    const outputPath = join(root, "dist", "worker.js");
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /<h1>safe<\/h1>/);
    assert.match(output, /PUBLIC_ORIGIN: "https:\/\/images\.example\.com"/);
    assert.match(output, /LEGACY_BUCKET_NAME: "legacy"/);
    const syntax = spawnSync(process.execPath, ["--check", outputPath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build rejects manifest paths outside public", () => {
  const root = fixture([["/secret", "../secret.txt", htmlType]]);
  writeFileSync(join(root, "secret.txt"), "must not be embedded");
  try {
    const result = runBuild(root);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, "dist", "worker.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build rejects symlinked manifest assets and output directories", () => {
  const root = fixture([["/secret", "secret.txt", htmlType]]);
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "must not be embedded");
  symlinkSync(outside, join(root, "public", "secret.txt"));
  try {
    const assetResult = runBuild(root);
    assert.notEqual(assetResult.status, 0);
    assert.equal(existsSync(join(root, "dist", "worker.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const second = fixture([["/", "index.html", htmlType]]);
  const externalDir = join(second, "external");
  mkdirSync(externalDir);
  symlinkSync(externalDir, join(second, "dist"), "dir");
  try {
    const outputResult = runBuild(second);
    assert.notEqual(outputResult.status, 0);
    assert.equal(existsSync(join(externalDir, "worker.js")), false);
  } finally {
    rmSync(second, { recursive: true, force: true });
  }
});

test("build rejects a symlinked Worker source file", () => {
  const root = fixture([["/", "index.html", htmlType]]);
  const source = join(root, "src", "index.js");
  const external = join(root, "external.js");
  writeFileSync(external, 'export default { async fetch(request, env, ctx) { return new Response("unsafe"); } };');
  rmSync(source);
  symlinkSync(external, source);
  try {
    const result = runBuild(root);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, "dist", "worker.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build rejects untrusted values in the rendered Wrangler configuration", () => {
  const root = fixture([["/", "index.html", htmlType]]);
  const configPath = join(root, "wrangler.jsonc");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.routes[0].pattern = 'images.example.com"; globalThis.injected = true; //';
  writeFileSync(configPath, JSON.stringify(config));
  try {
    assert.notEqual(runBuild(root).status, 0);
    assert.equal(existsSync(join(root, "dist", "worker.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build rejects duplicate manifest routes", () => {
  const root = fixture([
    ["/", "index.html", htmlType],
    ["/", "index.html", htmlType],
  ]);
  try {
    assert.notEqual(runBuild(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build rejects unsupported content types", () => {
  const root = fixture([["/", "index.html", "text/html"]]);
  try {
    assert.notEqual(runBuild(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

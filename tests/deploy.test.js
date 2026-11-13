// tools/deploy.sh renders a temporary copy and hands it to wrangler; the
// Deploy workflow feeds it every declared value from the repository secrets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const declared = [
  ...readFileSync(join(root, "cloudflare.example.env"), "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm),
].map((match) => match[1]);

// Runs deploy.sh with stand-ins for npm and npx, so nothing is installed or
// uploaded. The npx stand-in records where and how wrangler was called.
function deploy(args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-test-"));
  const log = join(dir, "log");
  writeFileSync(join(dir, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(dir, "npx"),
    '#!/bin/sh\n{ pwd; echo "$*"; } >"$DEPLOY_LOG"\ncp wrangler.jsonc "$DEPLOY_LOG.jsonc"\necho "${CLOUDFLARE_ACCOUNT_ID:-}" >"$DEPLOY_LOG.account"\n',
    { mode: 0o755 },
  );
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !declared.includes(name) && !name.startsWith("CLOUDFLARE_")),
  );
  const result = spawnSync("sh", [join(root, "tools/deploy.sh"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...clean, ...env, PATH: `${dir}:${process.env.PATH}`, DEPLOY_LOG: log },
  });
  const called = existsSync(log);
  const [cwd, command] = called ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  const config = called ? readFileSync(`${log}.jsonc`, "utf8") : "";
  const account = called ? readFileSync(`${log}.account`, "utf8").trim() : "";
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, called, cwd, command, config, account };
}

// A values file of your own: the example values followed by extra lines.
function valuesFile(t, ...extra) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-values-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "values.env");
  const example = readFileSync(join(root, "cloudflare.example.env"), "utf8");
  writeFileSync(file, [example, ...extra, ""].join("\n"));
  return file;
}

test("deploys a filled-in temporary copy from a values file and removes it", () => {
  const run = deploy(["cloudflare.example.env", "--dry-run"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.command, "wrangler deploy --dry-run");
  assert.match(run.config, /"pattern": "images\.example\.com"/);
  assert.doesNotMatch(run.config, /__[A-Z][A-Z0-9_]*__/);
  assert.ok(run.cwd.startsWith(join(root, "build") + sep), "the copy must live in the ignored build directory");
  assert.ok(!existsSync(run.cwd), "the copy must be removed afterwards");
});

test("takes the values from the environment and treats unset names as empty", () => {
  const run = deploy(["--dry-run"], {
    PUBLIC_HOST: "attic.example.net",
    PUBLIC_ORIGIN: "https://attic.example.net",
    GALLERY_BUCKET: "gallery",
    LEGACY_BUCKET: "legacy",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.command, "wrangler deploy --dry-run");
  assert.match(run.config, /"pattern": "attic\.example\.net"/);
  assert.doesNotMatch(run.config, /__[A-Z][A-Z0-9_]*__/);
  // Without a Secrets Store id the optional binding is left out.
  assert.doesNotMatch(run.config, /store_id/);
  assert.match(run.config, /"secrets_store_secrets": \[\s*\]/);
});

test("refuses to deploy without any values", () => {
  const run = deploy([]);
  assert.equal(run.status, 1);
  assert.equal(run.called, false);
  assert.match(run.stderr, /No values found/);
});

test("refuses a values file that does not exist", () => {
  const run = deploy(["missing.env"]);
  assert.equal(run.status, 1);
  assert.equal(run.called, false);
  assert.match(run.stderr, /No such values file/);
});

test("hands the Cloudflare account in a values file, or in a file it names, to wrangler", (t) => {
  const file = valuesFile(t, `CLOUDFLARE_ACCOUNT_ID=${"1".repeat(32)}`);
  assert.equal(deploy([file, "--dry-run"]).account, "1".repeat(32));
  const preset = deploy([file, "--dry-run"], { CLOUDFLARE_ACCOUNT_ID: "2".repeat(32) });
  assert.equal(preset.account, "2".repeat(32));
  const named = valuesFile(t, "CLOUDFLARE_ACCOUNT_ID=@account.txt");
  writeFileSync(join(dirname(named), "account.txt"), `${"3".repeat(32)}\r\n`);
  assert.equal(deploy([named, "--dry-run"]).account, "3".repeat(32));
});

test("refuses to upload without the Cloudflare Access values", (t) => {
  const run = deploy(["cloudflare.example.env"]);
  assert.equal(run.status, 1);
  assert.equal(run.called, false);
  assert.match(run.stderr, /CF_ACCESS_AUD is empty/);
  const filled = deploy([valuesFile(t, `CF_ACCESS_AUD=${"a".repeat(64)}`)]);
  assert.equal(filled.status, 0, filled.stderr);
});

test("the Deploy workflow passes every declared value and the Cloudflare token", () => {
  const workflow = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
  for (const name of [...declared, "CLOUDFLARE_API_TOKEN"])
    assert.ok(
      workflow.includes(`      ${name}: \${{ secrets.${name} }}\n`),
      `${name} is missing from the deploy job's env`,
    );
  assert.match(workflow, /run: sh tools\/deploy\.sh\n/);
  // Only the deploy step sees the values, not the install and test steps.
  assert.doesNotMatch(workflow, /^    env:/m);
});

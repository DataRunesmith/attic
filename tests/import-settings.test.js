import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const importer = join(root, "docker", "import-settings.sh");

/** Run the production importer against a disposable data directory. */
function run(data) {
  return spawnSync("sh", [importer], {
    cwd: root,
    env: { ...process.env, DATA_DIR: data },
    encoding: "utf8",
  });
}

test("settings importer recovers claimed imports and preserves newer values", () => {
  const data = mkdtempSync(join(tmpdir(), "attic import settings "));
  const oldClaim = join(data, ".import.claim.previous");
  mkdirSync(oldClaim);
  writeFileSync(join(data, "settings.env"), "KEEP=base\nOVERRIDE=base\n");
  writeFileSync(join(oldClaim, "import.env"), "OVERRIDE=claimed\nCLAIMED=yes\n");
  writeFileSync(join(data, "import.env"), "OVERRIDE=new\nNEW=value\n");
  try {
    const result = run(data);
    assert.equal(result.status, 0, result.stderr);
    const settings = Object.fromEntries(
      readFileSync(join(data, "settings.env"), "utf8")
        .trim().split("\n").map((line) => line.split("=", 2)),
    );
    assert.deepEqual(settings, {
      KEEP: "base",
      OVERRIDE: "new",
      CLAIMED: "yes",
      NEW: "value",
    });
    assert.equal(statSync(join(data, "settings.env")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(data, "import.env")), false);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("settings importer retries a previously claimed import on restart", () => {
  const data = mkdtempSync(join(tmpdir(), "attic import recovery "));
  const claim = join(data, ".import.claim-interrupted");
  mkdirSync(claim);
  writeFileSync(join(claim, "import.env"), "RECOVERED=yes\n");
  try {
    const result = run(data);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(data, "settings.env"), "utf8"), /RECOVERED=yes/);
    assert.equal(statSync(join(data, "settings.env")).mode & 0o777, 0o600);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

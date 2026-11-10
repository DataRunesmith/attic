import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "../tools/env.mjs";

test("shared environment parser handles quotes, escapes, duplicate keys, and file-backed values", () => {
  const dir = mkdtempSync(join(tmpdir(), "attic-env-test-"));
  const envFile = join(dir, "values.env");
  const secretFile = join(dir, "token.txt");
  try {
    writeFileSync(secretFile, "file-backed-secret\n\n");
    writeFileSync(envFile, [
      '# comment',
      'PUBLIC_HOST="images.example.com"',
      'MULTILINE=first\\nsecond',
      'TOKEN=@token.txt',
      'DUPLICATE=first',
      'DUPLICATE=second',
      'EMPTY=',
      'not a variable',
      '',
    ].join("\n"));
    const values = parseEnv(envFile);
    assert.equal(values.get("PUBLIC_HOST"), "images.example.com");
    assert.equal(values.get("MULTILINE"), "first\nsecond");
    assert.equal(values.get("TOKEN"), "file-backed-secret");
    assert.equal(values.get("DUPLICATE"), "second");
    assert.equal(values.get("EMPTY"), "");
    assert.equal(values.has("not a variable"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("environment parser rejects symlinked and out-of-directory secret files", () => {
  const dir = mkdtempSync(join(tmpdir(), "attic-env-boundary-"));
  const config = join(dir, "config");
  const envFile = join(config, "values.env");
  const outside = join(dir, "outside.txt");
  try {
    mkdirSync(config);
    writeFileSync(outside, "must-not-be-read");
    writeFileSync(envFile, "TOKEN=@../outside.txt\n");
    assert.throws(() => parseEnv(envFile), /escapes its configuration directory/);

    symlinkSync(outside, join(config, "secret-link.txt"));
    writeFileSync(envFile, "TOKEN=@secret-link.txt\n");
    assert.throws(() => parseEnv(envFile), /cannot use symlinks/);

    symlinkSync(envFile, join(config, "linked.env"));
    assert.throws(() => parseEnv(join(config, "linked.env")), /regular, non-symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

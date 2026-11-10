import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidAccountId,
  isValidBucketName,
  isValidHostname,
  validateBuildValues,
} from "../build-values.mjs";

/** Return a complete valid configuration fixture for Cloudflare build tests. */
function values() {
  return {
    PUBLIC_HOST: "images.example.com",
    PUBLIC_ORIGIN: "https://images.example.com",
    GALLERY_BUCKET: "attic-gallery",
    LEGACY_BUCKET: "attic-legacy",
    SECRETS_STORE_ID: "b".repeat(32),
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  };
}

test("shared Cloudflare build validation accepts a valid configuration", () => {
  const input = values();
  assert.equal(validateBuildValues(input), input);
  assert.equal(isValidAccountId(input.CLOUDFLARE_ACCOUNT_ID), true);
  assert.equal(isValidBucketName(input.GALLERY_BUCKET), true);
  assert.equal(isValidHostname(input.PUBLIC_HOST), true);
});

test("shared Cloudflare build validation rejects invalid and executable values", () => {
  for (const patch of [
    { PUBLIC_HOST: "bad host.example" },
    { PUBLIC_HOST: "https://images.example.com" },
    { PUBLIC_ORIGIN: "https://user:pass@images.example.com" },
    { PUBLIC_ORIGIN: "https://images.example.com/path" },
    { PUBLIC_ORIGIN: 'https://images.example.com";globalThis.pwned=true' },
    { GALLERY_BUCKET: "UpperCase" },
    { LEGACY_BUCKET: "attic-gallery" },
    { SECRETS_STORE_ID: "__SECRETS_STORE_ID__" },
    { CLOUDFLARE_ACCOUNT_ID: "not-an-account-id" },
  ]) {
    assert.throws(() => validateBuildValues({ ...values(), ...patch }));
  }
});

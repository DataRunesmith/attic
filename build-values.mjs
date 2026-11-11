/** Shared validation for values consumed by the Cloudflare build pipeline. */
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

/** Return true only for a valid Cloudflare R2 bucket name. */
export function isValidBucketName(value) {
  return typeof value === "string" && BUCKET_NAME.test(value);
}

/** Return true only for a 32-character hexadecimal Cloudflare account or store ID. */
export function isValidAccountId(value) {
  return typeof value === "string" && ACCOUNT_ID.test(value);
}

/** Return true only for a public DNS hostname without scheme, port, or path. */
export function isValidHostname(value) {
  if (typeof value !== "string" || value.length > 253) return false;
  const labels = value.split(".");
  return labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/** Validate every required Workers build value before any build or API mutation. */
export function validateBuildValues(values) {
  const required = [
    "PUBLIC_HOST", "PUBLIC_ORIGIN", "GALLERY_BUCKET", "LEGACY_BUCKET",
    "SECRETS_STORE_ID", "CLOUDFLARE_ACCOUNT_ID",
  ];
  const missing = required.filter((key) =>
    typeof values?.[key] !== "string" || values[key].length === 0
  );
  if (missing.length) throw new Error("Missing Cloudflare build values: " + missing.join(", "));
  if (!isValidBucketName(values.GALLERY_BUCKET) || !isValidBucketName(values.LEGACY_BUCKET))
    throw new Error("R2 bucket names are invalid.");
  if (values.GALLERY_BUCKET === values.LEGACY_BUCKET)
    throw new Error("GALLERY_BUCKET and LEGACY_BUCKET must be different.");
  if (values.CF_ACCESS_AUD !== undefined &&
      (typeof values.CF_ACCESS_AUD !== "string" || values.CF_ACCESS_AUD.length > 256 ||
       /[\u0000-\u001f\u007f]/.test(values.CF_ACCESS_AUD) ||
       /^__.*__$/.test(values.CF_ACCESS_AUD)))
    throw new Error("CF_ACCESS_AUD must be a plain audience value of at most 256 characters.");
  if (!isValidAccountId(values.SECRETS_STORE_ID))
    throw new Error("SECRETS_STORE_ID must be a 32-character hexadecimal ID.");
  if (!isValidAccountId(values.CLOUDFLARE_ACCOUNT_ID))
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID.");
  if (!isValidHostname(values.PUBLIC_HOST))
    throw new Error("PUBLIC_HOST must be a valid DNS hostname without a scheme or path.");
  let origin;
  try {
    origin = new URL(values.PUBLIC_ORIGIN);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid HTTPS origin.");
  }
  if (origin.protocol !== "https:" || origin.hostname !== values.PUBLIC_HOST ||
      origin.username || origin.password || origin.pathname !== "/" ||
      origin.search || origin.hash)
    throw new Error("PUBLIC_ORIGIN must be the HTTPS origin matching PUBLIC_HOST.");
  return values;
}

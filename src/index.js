// Attic – independent Cloudflare Worker, no database or queue.
// All private requests are protected using Cloudflare Access JWT verification,
// or, when AUTH_MODE=password (self-hosted container), a password session.
const textEncoder = new TextEncoder();
let certCache = { url: "", expires: 0, keys: [] };
const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const pngCrcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  pngCrcTable[n] = value >>> 0;
}
/** Compute the PNG CRC-32 used to validate each chunk. */
function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const MAX_UPLOAD = 12 * 1024 * 1024;
const IMAGE_TYPES = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  avif: "image/avif",
};
const PAGE_LIMIT = 500;

/** Serialize an API payload with the standard response headers. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Decode a base64url JWT segment into bytes. */
function base64UrlDecode(input) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
/** Decode JWT payload bytes as UTF-8 text. */
function utf8Decode(data) {
  return new TextDecoder().decode(data);
}

/** Normalize a user-facing label into a safe path segment. */
function slug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
// Password mode: a signed cookie "<expiry>.<hmac>" keyed by ADMIN_PASSWORD, so
// changing the password logs every session out.
const SESSION_COOKIE = "attic_session";
const SESSION_SECONDS = 30 * 24 * 3600;
/** Sign a password session value with the configured secret. */
async function sessionMac(password, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/[+/=]/g, (c) =>
    c === "+" ? "-" : c === "/" ? "_" : "",
  );
}
/** Read one named cookie without interpreting unrelated values. */
function cookieValue(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}
/** Verify the signed session cookie used by password mode. */
async function passwordAuthorized(request, env) {
  const password = String(env.ADMIN_PASSWORD || "");
  const [expiry, mac] = cookieValue(request, SESSION_COOKIE).split(".");
  if (password.length < 8 || !expiry || !mac || Number(expiry) < Date.now() / 1000) return false;
  const expected = await sessionMac(password, expiry);
  return expected.length === mac.length && timingSafeEqual(expected, mac);
}
/** Compare authentication values without leaking the first differing byte. */
function timingSafeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
/** Render the password login page and any fixed error message. */
function loginPage(message = "") {
  const body = `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Logga in – Attic</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101318;color:#f4f5f7;font:16px system-ui,sans-serif}.login{width:min(24rem,calc(100% - 3rem));padding:2rem;background:#1b2028;border:1px solid #39414e;border-radius:1rem}h1{margin-top:0}label{display:grid;gap:.5rem}input,button{box-sizing:border-box;width:100%;margin-top:.75rem;padding:.8rem;border-radius:.5rem;font:inherit}input{background:#101318;color:inherit;border:1px solid #596273}button{background:#3976d2;color:white;border:0;font-weight:600;cursor:pointer}p[role=alert]{color:#ff9c9c}</style></head><body><main class="login"><h1>Attic</h1><form method="post" action="/auth/login"><label>Lösenord <input type="password" name="password" autocomplete="current-password" required autofocus></label><button type="submit">Logga in</button></form>${message ? `<p role="alert">${message}</p>` : ""}</main></body></html>`;
  return new Response(body, {
    status: message ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

/** Atomically consume one slot from the shared password-login rate window. */
async function consumeLoginAttempt(bucket) {
  const key = "gallery/_system/login-rate-limit/global.json";
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await bucket.get(key);
    let state = { windowStart: Date.now(), attempts: 0 };
    if (current) {
      try {
        state = JSON.parse(await current.text());
      } catch {
        // Corrupt limiter state must not reset the protection.
        return { allowed: false, retryAfter: Math.ceil(LOGIN_WINDOW_MS / 1000) };
      }
      if (!Number.isSafeInteger(state.windowStart) || !Number.isSafeInteger(state.attempts) || state.attempts < 0)
        return { allowed: false, retryAfter: Math.ceil(LOGIN_WINDOW_MS / 1000) };
      if (Date.now() - state.windowStart >= LOGIN_WINDOW_MS)
        state = { windowStart: Date.now(), attempts: 0 };
    }
    const retryAfter = Math.max(1, Math.ceil((state.windowStart + LOGIN_WINDOW_MS - Date.now()) / 1000));
    if (state.attempts >= LOGIN_MAX_ATTEMPTS)
      return { allowed: false, retryAfter };
    const next = await bucket.put(key, JSON.stringify({
      windowStart: state.windowStart,
      attempts: state.attempts + 1,
    }), current
      ? { onlyIf: { etagMatches: current.etag } }
      : { onlyIf: { etagDoesNotMatch: "*" } });
    if (next) return { allowed: true, key, etag: next.etag };
  }
  return { allowed: false, retryAfter: Math.ceil(LOGIN_WINDOW_MS / 1000) };
}

/** Reset throttling only if the successful login still owns the stored version. */
async function resetLoginAttempts(bucket, attempt) {
  if (!attempt?.key || !attempt.etag) return;
  await bucket.put(attempt.key, JSON.stringify({ windowStart: Date.now(), attempts: 0 }), {
    onlyIf: { etagMatches: attempt.etag },
  });
}

/** Handle password login/logout routes and enforce persistent login throttling. */
async function passwordAuthRoute(request, env, url) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  if (url.pathname === "/auth/login" && request.method === "GET") return loginPage();
  if (url.pathname === "/auth/login" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get("password") || "");
    const password = String(env.ADMIN_PASSWORD || "");
    const bucket = env.GALLERY_BUCKET;
    if (!bucket) return json({ error: "Inloggningen är tillfälligt otillgänglig." }, 503);
    let attempt;
    try {
      attempt = await consumeLoginAttempt(bucket);
    } catch {
      return json({ error: "Inloggningen är tillfälligt otillgänglig." }, 503);
    }
    if (!attempt.allowed) {
      const limited = loginPage("För många inloggningsförsök. Försök igen senare.");
      const headers = new Headers(limited.headers);
      headers.set("retry-after", String(attempt.retryAfter));
      return new Response(limited.body, { status: 429, headers });
    }
    if (password.length < 8 || !timingSafeEqual(given, password)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return loginPage(
        password.length < 8 ? "ADMIN_PASSWORD saknas eller är för kort." : "Fel lösenord.",
      );
    }
    await resetLoginAttempts(bucket, attempt).catch(() => {});
    const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    const cookie = `${SESSION_COOKIE}=${expiry}.${await sessionMac(password, expiry)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`;
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie } });
  }
  // Same logout link as Access; behind Cloudflare the edge answers it instead.
  if (url.pathname === "/cdn-cgi/access/logout" || url.pathname === "/auth/logout") {
    const cookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
    return new Response(null, {
      status: 303,
      headers: { location: "/auth/login", "set-cookie": cookie },
    });
  }
  return null;
}

/** Authorize local development, native Workers Access, or explicit container JWT mode. */
async function accessAuthorized(ctx, env, request) {
  const hostname = new URL(request.url).hostname;
  if (env.LOCAL_DEV === "true" && (hostname === "localhost" || hostname === "127.0.0.1"))
    return true;
  // Native Workers Access is preferred in Cloudflare. The JWT fallback is retained
  // only for the standalone Docker/container deployment mode.
  if (ctx?.access) return true;
  if (env.AUTH_MODE === "cloudflare-access") return legacyAccessAuthorized(request, env);
  return false;
}

/** Validate the standalone container's Access JWT against cached JWKS keys. */
async function legacyAccessAuthorized(request, env) {
  const hostname = new URL(request.url).hostname;
  // Local development only. Never enable LOCAL_DEV in production config.
  if (env.LOCAL_DEV === "true" && (hostname === "localhost" || hostname === "127.0.0.1"))
    return true;
  const aud = String(env.CF_ACCESS_AUD || "");
  const team = String(env.CF_ACCESS_TEAM_DOMAIN || "");
  // An unrendered configuration placeholder is never a valid value.
  if (!aud || /^__.*__$/.test(aud) || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))
    return false;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(utf8Decode(base64UrlDecode(parts[0])));
    const payload = JSON.parse(utf8Decode(base64UrlDecode(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      payload.iss !== `https://${team}` ||
      !Number.isSafeInteger(payload.exp) || payload.exp <= now ||
      (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > now)) ||
      !(Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud)
    )
      return false;
    const certUrl = `https://${team}/cdn-cgi/access/certs`;
    if (certCache.url !== certUrl || certCache.expires < Date.now()) {
      const response = await fetch(certUrl, { headers: { accept: "application/json" } });
      if (!response.ok) return false;
      const data = await response.json();
      if (!Array.isArray(data.keys)) return false;
      certCache = { url: certUrl, expires: Date.now() + 15 * 60 * 1000, keys: data.keys };
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlDecode(parts[2]),
      textEncoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}

/** Return the validated public image origin used by gallery URLs. */
function publicAssetOrigin(env) {
  const raw = String(env.PUBLIC_ORIGIN || "");
  let url;
  try { url = new URL(raw); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    return "";
  return url.origin + "/bilder";
}

/** Convert an allowed R2 image object into its public URL representation. */
function keyToImage(object, prefix, publicOrigin) {
  const key = object.key;
  if (!key.startsWith(prefix)) return null;
  const rel = key.slice(prefix.length);
  const parts = rel.split("/");
  if (parts.length !== 3 && parts.length !== 4 && parts.length !== 6) return null;
  const category = parts[0];
  if (
    (category === "apps" && parts.length !== 3) ||
    (category === "themes" && parts.length !== 4 && parts.length !== 6) ||
    (parts.length === 6 && parts[3] !== "variants")
  )
    return null;
  if (!["apps", "themes"].includes(category)) return null;
  const filename = parts.at(-1);
  if (!/^[a-z0-9-]+\.png$/.test(filename)) return null;
  const match = filename.match(/-(512x512|1254x1254)-[a-z0-9]{8}\.png$/);
  return {
    key,
    name: filename,
    app: category === "themes" ? parts[2] : parts[1],
    variant: parts.length === 6 ? parts[4] : null,
    category,
    theme: category === "themes" ? parts[1] : null,
    dimensions: match ? match[1] : "okänt",
    type: "PNG",
    bytes: object.size || 0,
    uploaded: object.uploaded?.toISOString?.() || object.uploaded || "",
    url: `${publicOrigin.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`,
  };
}

// Validate PNG framing and the complete zlib image stream, not just IHDR.
// Interlaced PNGs are deliberately rejected; all supported exports are non-interlaced.
/** Validate PNG chunk framing, CRCs and the complete decompressed image stream. */
async function uploadedImageInfo(buffer) {
  if (buffer.byteLength < 57) return null;
  const bytes = new Uint8Array(buffer);
  if (!pngHeader.every((v, i) => bytes[i] === v)) return null;
  const view = new DataView(buffer);
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  let header = false, palette = false, idat = false, idatEnded = false, ended = false;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return null;
    const type = utf8Decode(bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    const next = end + 4;
    if (view.getUint32(end) !== pngCrc32(bytes.subarray(offset + 4, end))) return null;
    if (!header && type !== "IHDR") return null;
    if (type === "IHDR") {
      if (header || offset !== 8 || length !== 13) return null;
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      if (![512, 1254].includes(width) || width !== height) return null;
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] !== 0)
        return null;
      const validDepth = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!validDepth[colorType]?.includes(bitDepth)) return null;
      header = true;
    } else if (type === "PLTE") {
      if (palette || idat || !length || length > 768 || length % 3 !== 0 ||
          colorType === 0 || colorType === 4) return null;
      palette = true;
    } else if (type === "IDAT") {
      if (idatEnded || (colorType === 3 && !palette)) return null;
      idat = true;
      imageData.push(bytes.subarray(start, end));
    } else if (type === "IEND") {
      if (length !== 0 || !idat || next !== bytes.length) return null;
      ended = true;
      offset = next;
      break;
    } else {
      if (["acTL", "fcTL", "fdAT"].includes(type)) return null;
      if (idat) idatEnded = true;
      // Unknown critical chunks cannot be safely interpreted.
      if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90 &&
          !["tRNS"].includes(type)) return null;
    }
    if (idat && type !== "IDAT") idatEnded = true;
    offset = next;
  }
  if (!ended || offset !== bytes.length || !imageData.length) return null;

  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const rowStride = rowBytes + 1;
  const expected = rowStride * height;
  let total = 0;
  let reader;
  try {
    const stream = new Blob(imageData).stream().pipeThrough(new DecompressionStream("deflate"));
    reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Inspect only the filter byte at the start of each decompressed row.
      for (let i = (rowStride - (total % rowStride)) % rowStride;
        i < value.length; i += rowStride) {
        if (value[i] > 4) {
          await reader.cancel();
          return null;
        }
      }
      total += value.length;
      if (total > expected) {
        await reader.cancel();
        return null;
      }
    }
  } catch {
    return null;
  } finally {
    reader?.releaseLock();
  }
  return total === expected ? { width, height } : null;
}

const LEGACY_IMAGE_KEY = /^(?:apps|uploads)\/[a-zA-Z0-9/_-]+\.(?:png|webp|jpe?g|gif|avif)$/;
const IMPORTED_IMAGE_KEY =
  /^imported\/(?:apps|uploads)\/[a-zA-Z0-9/_-]+\.(?:png|webp|jpe?g|gif|avif)$/;
const MAX_LEGACY_BYTES = 16 * 1024 * 1024;
// Read only the image header. No pixels are decoded and no object is changed.
/** Read image dimensions from a bounded PNG or JPEG header. */
function r2HeaderDimensions(b, ext) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const be = (i) => (i + 4 <= b.length ? dv.getUint32(i, false) : 0);
  let w = 0,
    h = 0;
  if (
    ext === "png" &&
    b.length >= 24 &&
    b[0] === 137 &&
    b[1] === 80 &&
    b[2] === 78 &&
    b[3] === 71 &&
    b[12] === 73 &&
    b[13] === 72 &&
    b[14] === 68 &&
    b[15] === 82
  ) {
    w = be(16);
    h = be(20);
  } else if (ext === "gif" && b.length >= 10 && String.fromCharCode(...b.slice(0, 3)) === "GIF") {
    w = b[6] | (b[7] << 8);
    h = b[8] | (b[9] << 8);
  } else if (
    ext === "webp" &&
    b.length >= 30 &&
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP"
  ) {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8X") {
      w = 1 + b[24] + (b[25] << 8) + (b[26] << 16);
      h = 1 + b[27] + (b[28] << 8) + (b[29] << 16);
    } else if (kind === "VP8 " && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) {
      w = (b[26] | (b[27] << 8)) & 0x3fff;
      h = (b[28] | (b[29] << 8)) & 0x3fff;
    } else if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
      w = 1 + (b[21] | ((b[22] & 63) << 8));
      h = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 15) << 10));
    }
  } else if ((ext === "jpg" || ext === "jpeg") && b.length >= 12 && b[0] === 255 && b[1] === 216) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 255) {
        i++;
        continue;
      }
      while (i < b.length && b[i] === 255) i++;
      const marker = b[i++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > b.length) break;
      const len = (b[i] << 8) | b[i + 1];
      if (len < 2 || i + len > b.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        len >= 7
      ) {
        h = (b[i + 3] << 8) | b[i + 4];
        w = (b[i + 5] << 8) | b[i + 6];
        break;
      }
      i += len;
    }
  } else if (ext === "avif" && b.length >= 32 && String.fromCharCode(...b.slice(4, 8)) === "ftyp") {
    // AVIF stores pixel dimensions in an `ispe` property box.
    for (let i = 4; i + 16 <= b.length; i++) {
      if (b[i] === 105 && b[i + 1] === 115 && b[i + 2] === 112 && b[i + 3] === 101) {
        const boxLength = be(i - 4),
          tw = be(i + 8),
          th = be(i + 12);
        if (boxLength >= 20 && tw > 0 && th > 0) {
          w = tw;
          h = th;
          break;
        }
      }
    }
  }
  if (
    !Number.isSafeInteger(w) ||
    !Number.isSafeInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > 100000 ||
    h > 100000
  )
    return null;
  return { width: w, height: h, dimensions: `${w}x${h}` };
}
/** Return the minimum byte range needed to identify image dimensions. */
function r2HeaderBytes(ext) {
  return ext === "jpeg" || ext === "jpg" || ext === "avif" ? 65536 : 64;
}
/** Parse cached dimension metadata when it is structurally valid. */
function r2MetadataDimensions(meta) {
  const w = Number(meta?.width),
    h = Number(meta?.height);
  return Number.isSafeInteger(w) &&
    Number.isSafeInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= 100000 &&
    h <= 100000
    ? { width: w, height: h, dimensions: `${w}x${h}` }
    : null;
}
// Dimensions are read once per object version: from customMetadata when set at
// write time, otherwise from the edge cache, and only then from an R2 range read.
// Cache lookups are free, so repeat scans cost no R2 reads for known objects.
const DIMENSION_CACHE_ORIGIN = "https://dimension-cache.attic.invalid/";
/** Fetch only the image header range and derive its dimensions. */
async function r2ScanImage(bucket, source, object) {
  const fromMetadata = r2MetadataDimensions(object.customMetadata);
  if (fromMetadata) return fromMetadata;
  const cacheKey = new Request(
    DIMENSION_CACHE_ORIGIN +
      encodeURIComponent(source) +
      "/" +
      encodeURIComponent(object.key) +
      "?etag=" +
      encodeURIComponent(object.etag || ""),
  );
  const cache = globalThis.caches?.default;
  try {
    const hit = cache && (await cache.match(cacheKey));
    if (hit) return await hit.json();
  } catch {}
  const ext = object.key.split(".").at(-1).toLowerCase();
  let dimensions = null;
  try {
    const head = await bucket.get(object.key, { range: { offset: 0, length: r2HeaderBytes(ext) } });
    if (head) dimensions = r2HeaderDimensions(new Uint8Array(await head.arrayBuffer()), ext);
  } catch {
    return null;
  }
  try {
    if (cache)
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(dimensions), {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=31536000, immutable",
          },
        }),
      );
  } catch {}
  return dimensions;
}

/** Validate and normalize a requested R2 source selection. */
function r2Selection(query) {
  if (query === "legacy")
    return { name: "legacy", binding: "LEGACY_BUCKET", prefix: "", keyPattern: LEGACY_IMAGE_KEY };
  if (query === "attic")
    return {
      name: "attic",
      binding: "GALLERY_BUCKET",
      prefix: "imported/",
      keyPattern: IMPORTED_IMAGE_KEY,
    };
  return null;
}
/** Enforce the source-specific allowlist for R2 object keys. */
function r2KeyAllowed(bucket, key) {
  return (
    typeof key === "string" &&
    key.length < 420 &&
    bucket.keyPattern.test(key) &&
    !key.includes("//") &&
    !key.includes("..")
  );
}
/** Handle authenticated R2 listing, preview, import, and deletion routes. */
async function r2Api(request, env, url) {
  const selection = r2Selection(url.searchParams.get("source"));
  const isList = url.pathname === "/api/r2/items" && request.method === "GET";
  const isPreview = url.pathname === "/api/r2/preview" && request.method === "GET";
  const isImport = url.pathname === "/api/r2/import" && request.method === "POST";
  const isDelete = url.pathname === "/api/r2/delete" && request.method === "POST";
  if (!isList && !isPreview && !isImport && !isDelete)
    return json({ error: "Sidan finns inte." }, 404);
  if ((isImport || isDelete) && !sameOriginRequest(request))
    return json({ error: "Otillåten förfrågan." }, 403);
  if (
    (isImport || isDelete) &&
    request.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
  )
    return json({ error: "Kräver JSON." }, 415);
  let data = {};
  if (isImport || isDelete) {
    try {
      if (Number(request.headers.get("content-length") || 0) > 4096)
        return json({ error: "För stor begäran." }, 413);
      data = await request.json();
    } catch {
      return json({ error: "Ogiltig JSON." }, 400);
    }
  }
  const src = isImport || isDelete ? r2Selection(data?.source) : selection;
  if (!src || !env[src.binding])
    return json({ error: "Okänd eller otillgänglig R2-lagring." }, 400);
  const bucket = env[src.binding];
  if (isList) {
    const cursor = url.searchParams.get("cursor") || undefined;
    if (cursor && cursor.length > 2048) return json({ error: "Ogiltig markör." }, 400);
    try {
      const listing = await bucket.list({
        prefix: src.prefix,
        limit: 100,
        cursor,
        include: ["customMetadata"],
      });
      const valid = listing.objects.filter((o) => r2KeyAllowed(src, o.key));
      // Range reads happen only for objects never scanned before (see r2ScanImage).
      const items = await Promise.all(
        valid.map(async (o) => {
          const dimensions = await r2ScanImage(bucket, src.name, o);
          return {
            key: o.key,
            size: o.size,
            etag: o.etag || null,
            modified: o.uploaded?.toISOString?.() || o.uploaded || "",
            name: o.key.split("/").at(-1),
            folder: o.key.slice(0, o.key.lastIndexOf("/")),
            format: o.key.split(".").at(-1).toUpperCase().replace("JPEG", "JPG"),
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            dimensions: dimensions?.dimensions ?? null,
          };
        }),
      );
      return json({
        items,
        truncated: !!listing.truncated,
        cursor: listing.truncated ? listing.cursor : null,
      });
    } catch {
      return json({ error: "Kan inte lista R2-filerna." }, 503);
    }
  }
  const key = isPreview ? url.searchParams.get("key") : data?.key;
  if (!r2KeyAllowed(src, key)) return json({ error: "Ogiltig filsökväg." }, 400);
  if (isPreview) {
    try {
      const obj = await bucket.get(key);
      if (!obj) return new Response("Filen finns inte.", { status: 404 });
      if (obj.size > MAX_LEGACY_BYTES) return new Response("Filen är för stor.", { status: 413 });
      const ext = key.split(".").at(-1).toLowerCase();
      return new Response(obj.body, {
        headers: {
          "content-type": IMAGE_TYPES[ext],
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'",
          "content-disposition": "inline",
        },
      });
    } catch {
      return new Response("Kunde inte läsa bilden.", { status: 503 });
    }
  }
  if (typeof data.etag !== "string" || !/^[a-fA-F0-9]{32,64}(?:-\d+)?$/.test(data.etag))
    return json({ error: "Filens kontrollvärde saknas." }, 400);
  try {
    const meta = await bucket.head(key);
    if (!meta) return json({ error: "Filen finns inte längre." }, 404);
    if (meta.etag !== data.etag)
      return json({ error: "Filen har ändrats. Uppdatera listan." }, 409);
    if (isImport) {
      if (src.name !== "legacy" || !env.GALLERY_BUCKET)
        return json({ error: "Endast äldre filer kan importeras." }, 400);
      if (meta.size > MAX_LEGACY_BYTES)
        return json({ error: "Filen är för stor för direktimport." }, 413);
      const destinationKey = "imported/" + key;
      if (await env.GALLERY_BUCKET.head(destinationKey))
        return json(
          { error: "Bilden finns redan i Attic och skrivs inte över.", destinationKey },
          409,
        );
      const original = await bucket.get(key);
      if (!original || original.etag !== data.etag)
        return json({ error: "Filen ändrades under importen." }, 409);
      // Buffered (bounded by MAX_LEGACY_BYTES) so the copy records its dimensions once.
      const bytes = new Uint8Array(await original.arrayBuffer());
      const ext = key.split(".").at(-1).toLowerCase();
      const dimensions = r2HeaderDimensions(bytes.subarray(0, r2HeaderBytes(ext)), ext);
      await env.GALLERY_BUCKET.put(destinationKey, bytes, {
        httpMetadata: { contentType: original.httpMetadata?.contentType || "image/png" },
        customMetadata: {
          copiedFrom: env.LEGACY_BUCKET_NAME || "legacy",
          originalKey: key,
          ...(dimensions
            ? { width: String(dimensions.width), height: String(dimensions.height) }
            : {}),
        },
      });
      const verification = await env.GALLERY_BUCKET.head(destinationKey);
      if (!verification || verification.size !== meta.size)
        return json({ error: "Kopian kunde inte verifieras. Originalet finns kvar." }, 503);
      return json(
        { copied: true, key: destinationKey, source: key, bytes: verification.size },
        201,
      );
    }
    if (data.confirm !== "RADERA") return json({ error: "Bekräftelse saknas." }, 400);
    await bucket.delete(key);
    if (await bucket.head(key))
      return json({ error: "Filen kunde inte verifieras som raderad." }, 503);
    return json({ deleted: true, key });
  } catch {
    return json({ error: "R2-åtgärden misslyckades. Originalfilen kan finnas kvar." }, 503);
  }
}

/** Reject mutation requests that do not originate from the configured site. */
function sameOriginRequest(request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return false;
  return !!origin && origin === new URL(request.url).origin;
}

// "Använd i App Launcher": sets a theme's icons as the logos of the Cloudflare
// Access apps, through the API with WORKERS_API_TOKEN (Access: Apps: Edit).
/** Call the configured Cloudflare API with bounded request timeouts. */
async function themeCF(env, method, path, body) {
  const token =
      typeof env.WORKERS_API_TOKEN === "string"
        ? env.WORKERS_API_TOKEN
        : await env.WORKERS_API_TOKEN.get(),
    acct = env.CF_ACCESS_ACCOUNT_ID || "";
  if (!token) throw Error("WORKERS_API_TOKEN saknas.");
  if (!/^[a-f0-9]{32}$/.test(acct)) throw Error("Ogiltigt konto-ID.");
  const ctrl = new AbortController(),
    timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts/" + acct + path, {
      method,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctrl.signal,
    });
    const d = await res.json();
    if (!res.ok || !d.success)
      throw Error(
        (d.errors || []).map((x) => x.message).join("; ") || "Cloudflare API-fel " + res.status,
      );
    return d.result;
  } finally {
    clearTimeout(timer);
  }
}
/** Load the supported application catalogue for theme planning. */
async function themeApps(env) {
  const all = [];
  for (let i = 1; i <= 20; i++) {
    const a = await themeCF(env, "GET", "/access/apps?page=" + i + "&per_page=100");
    if (!Array.isArray(a)) throw Error("Ogiltig applista.");
    all.push(...a);
    if (a.length < 100) break;
  }
  return all.filter(
    (a) => ["self_hosted", "saas", "bookmark"].includes(a.type) && a.app_launcher_visible !== false,
  );
}
/** Build the requested theme image plan from application metadata. */
async function themePlan(env, theme, size) {
  let cursor;
  const icons = [];
  for (let i = 0; i < 20; i++) {
    const listing = await env.GALLERY_BUCKET.list({
      prefix: "gallery/themes/" + theme + "/",
      cursor,
      limit: 500,
    });
    for (const o of listing.objects) {
      const img = keyToImage(o, "gallery/", publicAssetOrigin(env));
      if (img && img.theme === theme && img.dimensions === size) icons.push(img);
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
    if (i === 19) throw Error("För många temabilder.");
  }
  if (!icons.length) throw Error("Temat saknar bilder i vald upplösning.");
  return (await themeApps(env)).map((app) => {
    const options = icons.filter((x) => x.app === slug(app.name)),
      base = options.filter((x) => !x.variant),
      variants = [...new Set(options.map((x) => x.variant).filter(Boolean))],
      allowed = base.length ? base : variants.length === 1 ? options : [];
    allowed.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
    const pic = allowed[0],
      url = pic?.url || "",
      old_url = app.logo_url || "";
    return {
      id: app.id,
      name: app.name,
      old_url,
      url,
      change: !!url && url !== old_url,
      reason: !url
        ? variants.length > 1
          ? "Flera varianter – går inte att välja automatiskt."
          : "Ingen ikon hittad"
        : url === old_url
          ? "Redan aktiv"
          : null,
    };
  });
}
/** Construct the upstream image request for one supported application. */
function themeRequest(app, url) {
  const whitelist = [
    "type",
    "name",
    "domain",
    "destinations",
    "self_hosted_domains",
    "saas_app",
    "tags",
    "app_launcher_visible",
    "allowed_idps",
    "auto_redirect_to_identity",
    "allow_authenticate_via_warp",
    "session_duration",
    "http_only_cookie_attribute",
    "same_site_cookie_attribute",
    "path_cookie_attribute",
    "enable_binding_cookie",
    "skip_interstitial",
    "options_preflight_bypass",
    "cors_headers",
    "eager_redirect_cookie_setting",
    "custom_pages",
    "custom_deny_url",
    "custom_non_identity_deny_url",
    "custom_deny_message",
    "read_service_tokens_from_header",
    "service_auth_401_redirect",
    "use_clientless_isolation_app_launcher_url",
    "allow_iframe",
    "mfa_config",
    "oauth_configuration",
    "scim_config",
  ];
  const p = { logo_url: url };
  for (const key of whitelist) if (Object.hasOwn(app, key)) p[key] = app[key];
  if (Array.isArray(app.policies)) {
    p.policies = app.policies.map((x) =>
      typeof x === "string"
        ? x
        : x.id
          ? {
              id: x.id,
              ...(x.account_id ? { account_id: x.account_id } : {}),
              ...(x.precedence !== undefined ? { precedence: x.precedence } : {}),
            }
          : null,
    );
    if (p.policies.some((x) => !x)) throw Error("Policylänkarna kunde inte bevaras.");
  }
  if (!p.type || !p.name) throw Error("Ofullständig app.");
  return p;
}
/** Handle theme previews, downloads, and application-specific operations. */
async function themeHandler(request, env, url) {
  if (request.method !== "POST") return json({ error: "Metoden stöds inte." }, 405);
  if (!sameOriginRequest(request)) return json({ error: "Otillåten förfrågan." }, 403);
  if (Number(request.headers.get("content-length") || 0) > 100000)
    return json({ error: "För stor förfrågan." }, 413);
  let d;
  try {
    d = await request.json();
  } catch {
    return json({ error: "Ogiltig JSON." }, 400);
  }
  const theme = String(d.theme || ""),
    size = String(d.size || "");
  if (
    !theme ||
    theme.length > 48 ||
    slug(theme) !== theme ||
    !["512x512", "1254x1254"].includes(size)
  )
    return json({ error: "Ogiltigt tema eller upplösning." }, 400);
  if (!env.WORKERS_API_TOKEN)
    return json({ error: "Anslut WORKERS_API_TOKEN från Secrets Store." }, 503);
  try {
    const rows = await themePlan(env, theme, size);
    if (url.pathname === "/api/theme/preview") return json({ rows });
    if (url.pathname !== "/api/theme/apply") return json({ error: "Okänd sökväg." }, 404);
    const changes = rows.filter((x) => x.change);
    if (
      !changes.length ||
      changes.length > 100 ||
      !Array.isArray(d.changes) ||
      d.changes.length !== changes.length ||
      !changes.every((x) =>
        d.changes.some((y) => y.id === x.id && y.old_url === x.old_url && y.url === x.url),
      )
    )
      return json({ error: "Matchningarna har ändrats. Förhandsgranska igen." }, 409);
    const original = [];
    for (const x of changes) {
      const app = await themeCF(env, "GET", "/access/apps/" + encodeURIComponent(x.id));
      if ((app.logo_url || "") !== x.old_url)
        throw Error(x.name + " har ändrats sedan förhandsgranskningen.");
      original.push({ row: x, app });
    }
    let updated = 0;
    const failed = [];
    for (const { row, app } of original) {
      try {
        await themeCF(
          env,
          "PUT",
          "/access/apps/" + encodeURIComponent(row.id),
          themeRequest(app, row.url),
        );
        const after = await themeCF(env, "GET", "/access/apps/" + encodeURIComponent(row.id));
        if (after.logo_url !== row.url) throw Error("Ikonen kunde inte verifieras.");
        const ids = (a) =>
          (a.policies || [])
            .map((x) => (typeof x === "string" ? x : x.id))
            .sort()
            .join("|");
        if (ids(app) !== ids(after))
          throw Error("Policyavvikelse – kontrollera appens policyer i Cloudflare.");
        updated++;
      } catch (e) {
        failed.push({ name: row.name, error: e.message });
      }
    }
    return json({ updated, failed });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Okänt fel." }, 502);
  }
}

/** Parse a bounded JSON mutation body and reject malformed input. */
async function readMutationJson(request) {
  if (!sameOriginRequest(request)) return { error: json({ error: "Otillåten förfrågan." }, 403) };
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    return { error: json({ error: "Kräver JSON." }, 415) };
  if (Number(request.headers.get("content-length") || 0) > 100_000)
    return { error: json({ error: "För stor begäran." }, 413) };
  try {
    return { data: await request.json() };
  } catch {
    return { error: json({ error: "Ogiltig JSON." }, 400) };
  }
}

// Delete catalogued images by key. Only keys that parse as gallery images are
// accepted, so nothing outside the catalogue can be removed through this route.
/** Delete validated gallery keys and report partial progress explicitly. */
async function galleryDelete(request, bucket, prefix, origin) {
  const { data, error } = await readMutationJson(request);
  if (error) return error;
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  if (!keys.length || keys.length > 1000)
    return json({ error: "Ange mellan 1 och 1000 bilder." }, 400);
  if (
    !keys.every(
      (key) => typeof key === "string" && keyToImage({ key, size: 0 }, prefix, origin) !== null,
    )
  )
    return json({ error: "Ogiltig bildnyckel." }, 400);
  try {
    await bucket.delete(keys);
    return json({ deleted: keys.length });
  } catch {
    return json({ error: "Bilderna kunde inte raderas." }, 503);
  }
}

// A short-lived R2 lease serializes theme uploads and deletion without another service.
const THEME_LOCK_LEASE_MS = 10 * 60 * 1000;
/** Derive the internal R2 lease key for one normalized theme. */
function themeLockKey(prefix, theme) {
  return `${prefix}_system/theme-locks/${theme}.json`;
}
/** Read a theme lease and fail closed when its persisted state is malformed. */
async function readThemeLock(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return { etag: null, active: false };
  try {
    const state = JSON.parse(await object.text());
    const validLease = state?.state === "deleting" &&
      Number.isSafeInteger(state.expires) && state.expires > 0;
    const validRelease = state?.state === "released" && state.expires === 0;
    if (!validLease && !validRelease)
      return { etag: object.etag, active: true };
    return { etag: object.etag, active: validLease && state.expires > Date.now() };
  } catch {
    // An unreadable lock must fail closed rather than permit writes during deletion.
    return { etag: object.etag, active: true };
  }
}
/** Acquire or replace an expired lease with an R2 compare-and-swap write. */
async function acquireThemeLock(bucket, key) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readThemeLock(bucket, key);
    if (current.active) return null;
    const state = JSON.stringify({
      state: "deleting",
      expires: Date.now() + THEME_LOCK_LEASE_MS,
      token: crypto.randomUUID(),
    });
    const options = current.etag
      ? { onlyIf: { etagMatches: current.etag } }
      : { onlyIf: { etagDoesNotMatch: "*" } };
    const lock = await bucket.put(key, state, options);
    if (lock) return { key, etag: lock.etag };
  }
  return null;
}
/** Extend a lease only while its etag still belongs to this deletion. */
async function renewThemeLock(bucket, lock) {
  const next = await bucket.put(lock.key, JSON.stringify({
    state: "deleting",
    expires: Date.now() + THEME_LOCK_LEASE_MS,
  }), { onlyIf: { etagMatches: lock.etag } });
  if (!next) throw new Error("Theme deletion lease was lost.");
  lock.etag = next.etag;
}
/** Mark a lease released without overwriting a newer lease owner. */
async function releaseThemeLock(bucket, lock) {
  await bucket.put(lock.key, JSON.stringify({ state: "released", expires: 0 }), {
    onlyIf: { etagMatches: lock.etag },
  });
}

// Delete every object under one theme folder while blocking racing uploads.
/** Delete a theme in bounded batches while coordinating concurrent uploads. */
async function themeDelete(request, bucket, prefix) {
  const { data, error } = await readMutationJson(request);
  if (error) return error;
  const theme = String(data?.theme || "");
  if (!theme || theme.length > 48 || slug(theme) !== theme)
    return json({ error: "Ogiltigt tema." }, 400);
  if (data?.confirm !== theme) return json({ error: "Bekräftelse saknas." }, 400);

  let lock;
  try {
    lock = await acquireThemeLock(bucket, themeLockKey(prefix, theme));
  } catch {
    return json({ error: "Temat kunde inte låsas för radering." }, 503);
  }
  if (!lock) return json({ error: "Temat raderas redan. Försök igen strax." }, 409);
  try {
    let deleted = 0;
    let complete = false;
    for (let page = 0; page < 50; page++) {
      await renewThemeLock(bucket, lock);
      const listing = await bucket.list({ prefix: `${prefix}themes/${theme}/`, limit: 1000 });
      const keys = listing.objects.map((object) => object.key).filter((key) => key !== lock.key);
      if (!keys.length && !listing.truncated) {
        complete = true;
        break;
      }
      if (keys.length) {
        await bucket.delete(keys);
        deleted += keys.length;
      }
    }
    if (!complete) {
      await renewThemeLock(bucket, lock);
      const remaining = await bucket.list({ prefix: `${prefix}themes/${theme}/`, limit: 1000 });
      if (remaining.truncated || remaining.objects.some((object) => object.key !== lock.key))
        return json({
          error: "Temat innehåller fler filer än en radering kan hantera åt gången.",
          deleted,
          theme,
        }, 503);
    }
    return json({ deleted, theme });
  } catch {
    return json({ error: "Temat kunde inte raderas." }, 503);
  } finally {
    await releaseThemeLock(bucket, lock).catch(() => {});
  }
}

/** Dispatch authenticated API routes and enforce the configured storage bindings. */
async function handleApi(request, env, url) {
  const bucket = env.GALLERY_BUCKET;
  if (!bucket) return json({ error: "Bildlagringen är inte konfigurerad." }, 503);
  const prefix = String(env.GALLERY_PREFIX || "gallery/");
  const origin = publicAssetOrigin(env);
  if (prefix !== "gallery/" || !origin)
    return json({ error: "Ogiltig lagringskonfiguration." }, 503);

  if (url.pathname.startsWith("/api/theme/")) return themeHandler(request, env, url);
  if (url.pathname.startsWith("/api/r2/")) return r2Api(request, env, url);
  if (url.pathname === "/api/gallery/delete" && request.method === "POST")
    return galleryDelete(request, bucket, prefix, origin);
  if (url.pathname === "/api/themes/delete" && request.method === "POST")
    return themeDelete(request, bucket, prefix);
  if (url.pathname === "/api/images" && request.method === "GET") {
    try {
      const cursor = url.searchParams.get("cursor") || undefined;
      if (cursor && cursor.length > 2048) return json({ error: "Ogiltig markör." }, 400);
      const listing = await bucket.list({ prefix, cursor, limit: PAGE_LIMIT });
      const images = listing.objects.map((o) => keyToImage(o, prefix, origin)).filter(Boolean);
      return json({
        images,
        cursor: listing.truncated ? listing.cursor : null,
        truncated: !!listing.truncated,
      });
    } catch {
      return json({ error: "Det gick inte att läsa bildarkivet." }, 503);
    }
  }
  if (url.pathname === "/api/upload" && request.method === "POST") {
    if (!sameOriginRequest(request)) return json({ error: "Otillåten förfrågan." }, 403);
    if (!/multipart\/form-data/i.test(request.headers.get("content-type") || ""))
      return json({ error: "Felaktigt formulär." }, 415);
    if (Number(request.headers.get("content-length") || 0) > MAX_UPLOAD + 128_000)
      return json({ error: "Filen är för stor." }, 413);
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "Uppladdningen kunde inte läsas." }, 400);
    }
    const file = form.get("file");
    const category = form.get("category");
    const rawApp = String(form.get("app") || "");
    const rawTheme = String(form.get("theme") || "");
    const rawVariant = String(form.get("variant") || "");
    const app = slug(rawApp),
      theme = slug(rawTheme),
      variant = slug(rawVariant);
    if (
      !(file instanceof File) ||
      !["apps", "themes"].includes(category) ||
      !app ||
      app.length > 48 ||
      (category === "themes" && (!theme || theme.length > 48)) ||
      (category === "apps" && (rawTheme.trim() || rawVariant.trim())) ||
      (variant && (category !== "themes" || variant.length > 48)) ||
      (rawVariant.trim() && !variant)
    )
      return json({ error: "Ange giltig kategori, applikation, tema och variant." }, 400);
    if (file.size > MAX_UPLOAD || file.size < 33)
      return json({ error: "Filen måste vara mindre än 12 MB." }, 413);
    if (!file.name.toLowerCase().endsWith(".png") || file.type !== "image/png")
      return json({ error: "Endast PNG tillåts." }, 415);
    const buffer = await file.arrayBuffer();
    const dimensions = await uploadedImageInfo(buffer);
    if (!dimensions)
      return json({ error: "Bilden måste vara en PNG i 512×512 eller 1254×1254 pixlar." }, 422);
    const folder =
      category === "apps"
        ? `apps/${app}`
        : `themes/${theme}/${app}${variant ? `/variants/${variant}` : ""}`;
    const name = `${theme ? theme + "-" : ""}${app}${variant ? "-" + variant : ""}-${dimensions.width}x${dimensions.height}-${crypto.randomUUID().slice(0, 8)}.png`;
    const key = `${prefix}${folder}/${name}`;
    const lockKey = category === "themes" ? themeLockKey(prefix, theme) : null;
    let lockSnapshot;
    let stored = false;
    try {
      if (lockKey) {
        lockSnapshot = await readThemeLock(bucket, lockKey);
        if (lockSnapshot.active)
          return json({ error: "Temat håller på att raderas. Försök igen strax." }, 409);
      }
      await bucket.put(key, buffer, {
        httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=86400" },
        customMetadata: {
          app,
          category,
          ...(category === "themes" ? { theme, ...(variant ? { variant } : {}) } : {}),
          width: String(dimensions.width),
          height: String(dimensions.height),
        },
      });
      stored = true;
      // If a deletion began while this upload was in flight, remove the just-written object.
      if (lockKey) {
        const after = await readThemeLock(bucket, lockKey);
        if (after.active || after.etag !== lockSnapshot.etag) {
          await bucket.delete(key);
          stored = false;
          return json({ error: "Temat håller på att raderas. Försök igen strax." }, 409);
        }
      }
      const uploaded = { key, size: buffer.byteLength, uploaded: new Date() };
      return json({ image: keyToImage(uploaded, prefix, origin) }, 201);
    } catch {
      if (stored) await bucket.delete(key).catch(() => {});
      return json({ error: "Kunde inte spara bilden." }, 503);
    }
  }
  return json({ error: "Sidan finns inte." }, 404);
}

// Only these three R2 prefixes are readable without signing in.
// The private /api/* and portal routes never pass through this public handler.
/** Serve only approved public image keys with safe cache headers. */
async function servePublicImage(request, env, url) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Metod stöds inte.", { status: 405, headers: { allow: "GET, HEAD" } });
  const path = url.pathname;
  if (!path.startsWith("/bilder/")) return new Response("Sidan finns inte.", { status: 404 });
  let key;
  try {
    key = decodeURIComponent(path.slice("/bilder/".length));
  } catch {
    return new Response("Ogiltig adress.", { status: 400 });
  }
  if (
    key.length > 500 ||
    key.includes("\\") ||
    key.includes("..") ||
    key.includes("//") ||
    /[?#%\u0000-\u001f]/.test(key) ||
    !/^(?:apps|uploads|gallery)\/[a-zA-Z0-9/_-]+\.(?:png|webp|jpe?g|gif|avif)$/.test(key)
  )
    return new Response("Sidan finns inte.", { status: 404 });
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  const selectedBucket = key.startsWith("gallery/") ? env.GALLERY_BUCKET : env.LEGACY_BUCKET;
  if (!selectedBucket) return new Response("Bildlagringen är inte tillgänglig.", { status: 503 });
  try {
    const object = await selectedBucket.get(key);
    if (!object)
      return new Response("Bilden finns inte.", {
        status: 404,
        headers: { "cache-control": "public, max-age=60" },
      });
    return new Response(request.method === "HEAD" ? null : object.body, {
      status: 200,
      headers: {
        "content-type": IMAGE_TYPES[ext],
        "content-length": String(object.size),
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "cross-origin",
        "referrer-policy": "no-referrer",
      },
    });
  } catch {
    return new Response("Bilden kunde inte hämtas.", { status: 503 });
  }
}

export default {
  /** Route public images, authentication, private APIs, and static assets. */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/bilder/")) return servePublicImage(request, env, url);
    if (env.AUTH_MODE === "password") {
      const authResponse = await passwordAuthRoute(request, env, url);
      if (authResponse) return authResponse;
      if (!(await passwordAuthorized(request, env)))
        return url.pathname.startsWith("/api/")
          ? json({ error: "Inloggning krävs." }, 401)
          : new Response(null, { status: 303, headers: { location: "/auth/login" } });
    } else if (!(await accessAuthorized(ctx, env, request)))
      return new Response("Åtkomst nekad. Cloudflare Access krävs.", {
        status: 403,
        headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
      });
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Metod stöds inte.", { status: 405 });
    if (!env.ASSETS?.fetch)
      return new Response("Webbplatsens filer är inte konfigurerade.", { status: 503 });
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-frame-options", "DENY");
    headers.set("cache-control", "no-store");
    headers.set(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
export { slug, keyToImage, uploadedImageInfo, sameOriginRequest };

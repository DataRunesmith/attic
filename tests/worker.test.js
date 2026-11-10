import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import worker, { slug, keyToImage, uploadedImageInfo } from "../src/index.js";

/** Create the intentionally incomplete PNG header fixture. */
function png(width = 512, height = 512) {
  const buffer = new ArrayBuffer(33);
  const bytes = new Uint8Array(buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return buffer;
}
const validPngCache = new Map();
/** Compute the PNG CRC-32 used to create valid and corrupted test chunks. */
function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Encode a PNG chunk with its length, type, payload, and CRC. */
function pngChunk(type, data) {
  const name = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(name, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}
/** Create a valid non-interlaced RGBA PNG fixture for upload tests. */
function validPng(width = 512, height = 512, ancillary = []) {
  const key = width + "x" + height + (ancillary.length ? ":ancillary" : "");
  if (validPngCache.has(key)) return validPngCache.get(key);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array(height * (1 + width * 4));
  const compressed = new Uint8Array(deflateSync(raw));
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...ancillary,
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  validPngCache.set(key, result.buffer);
  return result.buffer;
}
/** Create a PNG fixture with controlled invalid stream and header properties. */
function pngWithOptions({
  colorType = 6,
  interlace = 0,
  filter = 0,
  includePalette = true,
  idatBeforePalette = false,
  includeIend = true,
  truncateZlib = false,
  apng = false,
  rawLength,
  trailing = false,
} = {}) {
  const width = 512, height = 512;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  const rowBytes = Math.ceil(width * channels);
  const stride = rowBytes + 1;
  const raw = new Uint8Array(rawLength ?? stride * height);
  for (let y = 0; y < height && y * stride < raw.length; y++) raw[y * stride] = filter;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = colorType;
  header[12] = interlace;
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
  ];
  if (apng) chunks.push(pngChunk("acTL", new Uint8Array(8)));
  const compressed = new Uint8Array(deflateSync(raw));
  const idatData = truncateZlib ? compressed.subarray(0, compressed.length - 2) : compressed;
  const idat = pngChunk("IDAT", idatData);
  if (colorType === 3 && includePalette) {
    const palette = pngChunk("PLTE", new Uint8Array([0, 0, 0]));
    if (idatBeforePalette) chunks.push(idat, palette);
    else chunks.push(palette, idat);
  } else chunks.push(idat);
  if (includeIend) chunks.push(pngChunk("IEND", new Uint8Array(0)));
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0) + (trailing ? 1 : 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}
/** Provide a deterministic R2 test double with conditional-write support. */
function createBucket() {
  const items = new Map();
  const encode = (buffer) =>
    buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
  const reads = { full: 0, range: 0 };
  return {
    items,
    reads,
    async list({ prefix = "", cursor, include = [] }) {
      const objs = [...items.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, x]) => ({
          key,
          size: x.buffer.byteLength,
          etag: x.etag,
          uploaded: x.uploaded,
          ...(include.includes("customMetadata")
            ? { customMetadata: x.metadata?.customMetadata || {} }
            : {}),
        }));
      return { objects: objs, truncated: false };
    },
    async put(key, buffer, metadata = {}) {
      const current = items.get(key);
      if (metadata.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      if (metadata.onlyIf?.etagMatches &&
          current?.etag !== metadata.onlyIf.etagMatches) return null;
      let data;
      if (buffer?.getReader) {
        const response = new Response(buffer);
        data = new Uint8Array(await response.arrayBuffer());
      } else if (typeof buffer === "string") data = new TextEncoder().encode(buffer);
      else data = encode(buffer);
      const stored = {
        buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        metadata,
        etag: createHash("md5").update(data).digest("hex"),
        uploaded: new Date("2026-10-15T12:00:00Z"),
      };
      items.set(key, stored);
      return { etag: stored.etag };
    },
    async get(key, opts) {
      const x = items.get(key);
      if (!x) return null;
      if (opts?.range) reads.range++;
      else reads.full++;
      const data = opts?.range
        ? x.buffer.slice(opts.range.offset, opts.range.offset + opts.range.length)
        : x.buffer;
      return {
        body: new Uint8Array(data),
        size: x.buffer.byteLength,
        etag: x.etag,
        httpMetadata: x.metadata?.httpMetadata || { contentType: "image/png" },
        customMetadata: x.metadata?.customMetadata || {},
        async arrayBuffer() {
          return data.slice(0);
        },
        async text() {
          return new TextDecoder().decode(data);
        },
      };
    },
    async head(key) {
      const x = items.get(key);
      return x ? { size: x.buffer.byteLength, etag: x.etag } : null;
    },
    async delete(keys) {
      for (const key of [].concat(keys)) items.delete(key);
    },
  };
}
const assets = {
  async fetch() {
    return new Response("<!doctype html><title>Attic</title>", {
      headers: { "content-type": "text/html" },
    });
  },
};
/** Build the Worker environment used by isolated request tests. */
function env(bucket = createBucket()) {
  return {
    GALLERY_BUCKET: bucket,
    LEGACY_BUCKET: createBucket(),
    ASSETS: assets,
    GALLERY_PREFIX: "gallery/",
    PUBLIC_ORIGIN: "http://localhost",
    LOCAL_DEV: "true",
  };
}
/** Build a same-origin Worker request with optional request settings. */
function req(path = "/", opts = {}) {
  return new Request(`http://localhost${path}`, opts);
}
/** Build a multipart PNG upload request with the supplied image metadata. */
function uploadForm(
  filename = "plex.png",
  width = 512,
  height = 512,
  category = "apps",
  app = "Plex",
  theme = "",
) {
  const form = new FormData();
  form.set("category", category);
  form.set("app", app);
  form.set("theme", theme);
  form.set("file", new File([validPng(width, height)], filename, { type: "image/png" }));
  return form;
}
/** Send a same-origin multipart upload request to the Worker. */
function post(form, extra = {}) {
  return req("/api/upload", {
    method: "POST",
    headers: { origin: "http://localhost", ...extra },
    body: form,
  });
}

test("API rejects an invalid public asset origin", async () => {
  const e = env();
  e.PUBLIC_ORIGIN = 'https://example.com/path";globalThis.injected=true';
  const response = await worker.fetch(req("/api/images"), e);
  assert.equal(response.status, 503);
});

test("Production requests require Cloudflare Workers Access context", async () => {
  const e = env();
  delete e.LOCAL_DEV;
  assert.equal((await worker.fetch(req("/"), e)).status, 403);
  assert.equal((await worker.fetch(req("/api/images"), e)).status, 403);
  const accessContext = { access: { aud: "test-audience", getIdentity: async () => ({ email: "test@example.com" }) } };
  e.CF_ACCESS_AUD = "test-audience";
  assert.equal((await worker.fetch(req("/"), e, accessContext)).status, 200);
  assert.equal((await worker.fetch(req("/api/images"), e, accessContext)).status, 200);
  e.CF_ACCESS_AUD = "different-audience";
  assert.equal((await worker.fetch(req("/"), e, accessContext)).status, 403);
  e.CF_ACCESS_AUD = "";
});
test("Standalone Access fallback accepts a valid RS256 JWT", async () => {
  const team = "test.cloudflareaccess.com";
  const audience = "test-audience";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const makeToken = (claims) => {
    const payload = encode({ iss: "https://" + team, aud: [audience], ...claims });
    const input = header + "." + payload;
    return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  };
  const token = makeToken({ exp: now + 300, nbf: now - 1 });
  const e = env();
  e.LOCAL_DEV = "false";
  e.AUTH_MODE = "cloudflare-access";
  e.CF_ACCESS_TEAM_DOMAIN = team;
  e.CF_ACCESS_AUD = audience;
  const originalFetch = globalThis.fetch;
  let fetched = "";
  globalThis.fetch = async (url) => {
    fetched = String(url);
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const request = req("/", { headers: { "cf-access-jwt-assertion": token } });
    assert.equal((await worker.fetch(request, e)).status, 200);
    assert.equal(fetched, "https://" + team + "/cdn-cgi/access/certs");
    const missingExpiry = req("/", { headers: { "cf-access-jwt-assertion": makeToken({ nbf: now - 1 }) } });
    assert.equal((await worker.fetch(missingExpiry, e)).status, 403);
    const invalidNotBefore = req("/", {
      headers: { "cf-access-jwt-assertion": makeToken({ exp: now + 300, nbf: "not-a-time" }) },
    });
    assert.equal((await worker.fetch(invalidNotBefore, e)).status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Standalone Access fallback rejects missing, malformed and placeholder credentials", async () => {
  const e = env();
  delete e.LOCAL_DEV;
  e.AUTH_MODE = "cloudflare-access";
  e.CF_ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com";
  e.CF_ACCESS_AUD = "valid-audience";
  assert.equal((await worker.fetch(req("/"), e)).status, 403);
  assert.equal(
    (await worker.fetch(req("/", { headers: { "cf-access-jwt-assertion": "not.a.jwt" } }), e)).status,
    403,
  );
  e.CF_ACCESS_AUD = "__CF_ACCESS_AUD__";
  assert.equal(
    (await worker.fetch(req("/", { headers: { "cf-access-jwt-assertion": "not.a.jwt" } }), e)).status,
    403,
  );
});

test("Local test flag never works on deployed domain", async () => {
  const response = await worker.fetch(new Request("https://gallery.example.com/"), env());
  assert.equal(response.status, 403);
});
test("Local static pages are available with security headers", async () => {
  const r = await worker.fetch(req("/"), env());
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});
test("Empty gallery and metadata without exposing old assets", async () => {
  const e = env();
  e.GALLERY_BUCKET.items.set("apps/plex/original.png", { buffer: png(), uploaded: new Date() });
  const r = await worker.fetch(req("/api/images"), e);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.deepEqual(data.images, []);
  assert.equal(data.cursor, null);
});
test("Upload actual 512x512 PNG and list usable public link", async () => {
  const e = env();
  const r = await worker.fetch(post(uploadForm()), e);
  assert.equal(r.status, 201, await r.text().catch(() => ""));
  const images = await (await worker.fetch(req("/api/images"), e)).json();
  assert.equal(images.images.length, 1);
  const img = images.images[0];
  assert.equal(img.app, "plex");
  assert.equal(img.dimensions, "512x512");
  assert.match(img.key, /^gallery\/apps\/plex\/plex-512x512-[a-z0-9]{8}\.png$/);
  assert.equal(img.url, `http://localhost/bilder/${img.key}`);
  assert.equal(e.GALLERY_BUCKET.items.get(img.key).metadata.httpMetadata.contentType, "image/png");
});
test("Upload themes with category and application name in path", async () => {
  const e = env();
  const r = await worker.fetch(
    post(uploadForm("icon.png", 1254, 1254, "themes", "Plex", "Mörk natt")),
    e,
  );
  assert.equal(r.status, 201);
  const data = await r.json();
  assert.match(data.image.key, /^gallery\/themes\/mork-natt\/plex\/mork-natt-plex-1254x1254-/);
});
test("Reject invalid dimensions, malformed PNG and unwanted HTTP origin", async () => {
  const e = env();
  assert.equal((await worker.fetch(post(uploadForm("x.png", 600, 600)), e)).status, 422);
  assert.equal((await worker.fetch(post(uploadForm("x.png", 1254, 512)), e)).status, 422);
  assert.equal(
    (await worker.fetch(post(uploadForm("x.png", 512, 512), { origin: "https://evil.example" }), e))
      .status,
    403,
  );
  assert.equal(
    (await worker.fetch(post(uploadForm("x.png", 512, 512), { "sec-fetch-site": "cross-site" }), e))
      .status,
    403,
  );
  assert.equal(
    (await worker.fetch(post(uploadForm("x.png", 512, 512, "themes", "Plex", "")), e)).status,
    400,
  );
  assert.equal(e.GALLERY_BUCKET.items.size, 0);
});
test("Reject other methods and write access without bound bucket", async () => {
  const e = env();
  assert.equal((await worker.fetch(req("/api/images", { method: "DELETE" }), e)).status, 404);
  assert.equal((await worker.fetch(req("/", { method: "POST" }), e)).status, 405);
  delete e.GALLERY_BUCKET;
  assert.equal((await worker.fetch(req("/api/images"), e)).status, 503);
});
test("Normalize labels and reject filepaths not controlled by the gallery", async () => {
  assert.equal(slug(" Mörk natt! "), "mork-natt");
  assert.equal(slug("../_system/"), "system");
  assert.equal(
    keyToImage({ key: "_system/something.png" }, "gallery/", "__PUBLIC_ORIGIN__/bilder"),
    null,
  );
  assert.equal(
    keyToImage({ key: "gallery/not-a-category/item.png" }, "gallery/", "__PUBLIC_ORIGIN__/bilder"),
    null,
  );
  assert.deepEqual(await uploadedImageInfo(validPng(512, 512)), { width: 512, height: 512 });
  assert.equal(await uploadedImageInfo(png(512, 512)), null);
  assert.equal(await uploadedImageInfo(validPng(257, 257)), null);
});

test("PNG validator accepts ancillary chunks and rejects malformed or animated streams", async () => {
  const ancillary = validPng(512, 512, [
    pngChunk("gAMA", new Uint8Array([0, 0, 177, 143])),
  ]);
  assert.deepEqual(await uploadedImageInfo(ancillary), { width: 512, height: 512 });

  const badCrc = new Uint8Array(validPng(512, 512));
  badCrc[32] ^= 1;
  const badLength = new Uint8Array(validPng(512, 512));
  badLength[8] = 0x7f;
  const expected = (512 * 4 + 1) * 512;
  const shortRaw = pngWithOptions({ rawLength: expected - 1 });
  const longRaw = pngWithOptions({ rawLength: expected + 1 });
  const badFilter = pngWithOptions({ filter: 5 });
  const noPalette = pngWithOptions({ colorType: 3, includePalette: false });
  const idatBeforePalette = pngWithOptions({ colorType: 3, idatBeforePalette: true });
  const interlaced = pngWithOptions({ interlace: 1 });
  const missingIend = pngWithOptions({ includeIend: false });
  const trailing = pngWithOptions({ trailing: true });
  const truncatedZlib = pngWithOptions({ truncateZlib: true });
  const animated = pngWithOptions({ apng: true });
  for (const invalid of [
    badCrc.buffer, badLength.buffer, shortRaw, longRaw, badFilter, noPalette,
    idatBeforePalette, interlaced, missingIend, trailing, truncatedZlib, animated,
  ])
    assert.equal(await uploadedImageInfo(invalid), null);

  const e = env();
  const form = uploadForm();
  form.set("file", new File([truncatedZlib], "broken.png", { type: "image/png" }));
  assert.equal((await worker.fetch(post(form), e)).status, 422);
  assert.equal(e.GALLERY_BUCKET.items.size, 0);
});

test("Legacy application pictures are public at /bilder but do not expose other bucket objects", async () => {
  const e = env();
  delete e.LOCAL_DEV;
  await e.LEGACY_BUCKET.put("apps/plex/plex-1-512.png", png(), {
    httpMetadata: { contentType: "image/png" },
  });
  const r = await worker.fetch(
    new Request("https://gallery.example.com/bilder/apps/plex/plex-1-512.png"),
    e,
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await r.arrayBuffer()).byteLength, 33);
  const head = await worker.fetch(
    new Request("https://gallery.example.com/bilder/apps/plex/plex-1-512.png", { method: "HEAD" }),
    e,
  );
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(
    (
      await worker.fetch(
        new Request("https://gallery.example.com/bilder/apps/plex/plex-1-512.png", {
          method: "POST",
        }),
        e,
      )
    ).status,
    405,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://gallery.example.com/bilder/staging/themes-v2/private.png"),
        e,
      )
    ).status,
    404,
  );
  assert.equal(
    (await worker.fetch(new Request("https://gallery.example.com/bilder/_system/private.png"), e))
      .status,
    404,
  );
  assert.equal(
    (await worker.fetch(new Request("https://gallery.example.com/bilder/apps/plex/missing.png"), e))
      .status,
    404,
  );
  assert.equal(
    (await worker.fetch(new Request("https://gallery.example.com/api/images"), e)).status,
    403,
  );
  assert.equal((await worker.fetch(new Request("https://gallery.example.com/"), e)).status, 403);
});

test("Theme variant upload preserves nested variant identity", async () => {
  const e = env();
  const f = uploadForm("maskerad.png", 512, 512, "themes", "Whisparr", "Monument");
  f.set("variant", "Maskerad");
  const res = await worker.fetch(post(f), e);
  assert.equal(res.status, 201);
  const img = (await res.json()).image;
  assert.equal(img.theme, "monument");
  assert.equal(img.variant, "maskerad");
  assert.equal(img.app, "whisparr");
  assert.match(
    img.key,
    /^gallery\/themes\/monument\/whisparr\/variants\/maskerad\/monument-whisparr-maskerad-512x512-[a-z0-9]{8}\.png$/,
  );
  const gallery = (await (await worker.fetch(req("/api/images"), e)).json()).images;
  assert.equal(gallery[0].variant, "maskerad");
});

/** Send a same-origin JSON mutation request to the Worker. */
async function jpost(path, body, e, headers = {}) {
  return worker.fetch(
    req(path, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    e,
  );
}
test("R2 navigator lists 182-like original images without exposing them in gallery", async () => {
  const e = env();
  await e.LEGACY_BUCKET.put("apps/plex/plex-1-512.png", png(), {});
  await e.LEGACY_BUCKET.put("uploads/0123/F1.png", png(), {});
  await e.LEGACY_BUCKET.put("private/personal.png", png(), {});
  const res = await worker.fetch(req("/api/r2/items?source=legacy"), e);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].name, "plex-1-512.png");
  assert.deepEqual((await (await worker.fetch(req("/api/images"), e)).json()).images, []);
  assert.equal(
    (await worker.fetch(req("/api/r2/preview?source=legacy&key=private%2Fpersonal.png"), e)).status,
    400,
  );
});
test("Copy from the legacy bucket to the gallery imported prefix; no source deletion or theme pollution", async () => {
  const e = env();
  const key = "apps/plex/plex-1-512.png";
  await e.LEGACY_BUCKET.put(key, png(), { httpMetadata: { contentType: "image/png" } });
  const etag = (await e.LEGACY_BUCKET.head(key)).etag;
  const res = await jpost("/api/r2/import", { source: "legacy", key, etag }, e);
  assert.equal(res.status, 201, await res.text().catch(() => "error")); // cloned consumed response not needed
  assert.ok(await e.LEGACY_BUCKET.head(key));
  assert.ok(await e.GALLERY_BUCKET.head("imported/" + key));
  assert.equal(
    (await (await worker.fetch(req("/api/r2/items?source=attic"), e)).json()).items.length,
    1,
  );
  assert.equal((await (await worker.fetch(req("/api/images"), e)).json()).images.length, 0);
  assert.equal((await jpost("/api/r2/import", { source: "legacy", key, etag }, e)).status, 409);
  const picture = await worker.fetch(
    req("/api/r2/preview?source=attic&key=imported%2Fapps%2Fplex%2Fplex-1-512.png"),
    e,
  );
  assert.equal(picture.status, 200);
  assert.equal((await picture.arrayBuffer()).byteLength, 33);
});
test("Deletion requires explicit confirmation, correct etag, same-origin and limited keys", async () => {
  const e = env();
  const key = "apps/plex/plex-1-512.png";
  await e.LEGACY_BUCKET.put(key, png(), {});
  const etag = (await e.LEGACY_BUCKET.head(key)).etag;
  assert.equal((await jpost("/api/r2/delete", { source: "legacy", key, etag }, e)).status, 400);
  assert.equal(
    (
      await jpost("/api/r2/delete", { source: "legacy", key, etag, confirm: "RADERA" }, e, {
        origin: "https://example.com",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await jpost(
        "/api/r2/delete",
        { source: "legacy", key, etag: "b".repeat(32), confirm: "RADERA" },
        e,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await jpost(
        "/api/r2/delete",
        { source: "legacy", key: "../apps/plex/plex.png", etag, confirm: "RADERA" },
        e,
      )
    ).status,
    400,
  );
  assert.ok(await e.LEGACY_BUCKET.head(key));
  assert.equal(
    (await jpost("/api/r2/delete", { source: "legacy", key, etag, confirm: "RADERA" }, e)).status,
    200,
  );
  assert.equal(await e.LEGACY_BUCKET.head(key), null);
});
test("R2 public link isolation and access protection for navigator", async () => {
  const e = env();
  await e.GALLERY_BUCKET.put("gallery/apps/plex/plex-512x512-abcdef12.png", png(), {});
  await e.LEGACY_BUCKET.put("apps/plex/legacy.png", png(), {});
  const gallery = await worker.fetch(req("/bilder/gallery/apps/plex/plex-512x512-abcdef12.png"), e);
  assert.equal(gallery.status, 200);
  const old = await worker.fetch(req("/bilder/apps/plex/legacy.png"), e);
  assert.equal(old.status, 200);
  const denied = await worker.fetch(req("/bilder/imported/apps/plex/legacy.png"), e);
  assert.equal(denied.status, 404);
  delete e.LOCAL_DEV;
  assert.equal((await worker.fetch(req("/api/r2/items?source=legacy"), e)).status, 403);
});

/** Install an isolated cache mock and return a function that restores globals. */
function stubEdgeCache() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? new Response(hit) : undefined;
      },
      async put(request, response) {
        store.set(request.url, await response.text());
      },
    },
  };
  return () => {
    delete globalThis.caches;
  };
}
test("R2 scan reads each legacy image header once, then serves dimensions from the edge cache", async () => {
  const restore = stubEdgeCache();
  try {
    const e = env();
    await e.LEGACY_BUCKET.put("apps/plex/plex-1-512.png", png(640, 480), {});
    await e.LEGACY_BUCKET.put("apps/emby/emby-1-512.png", png(), {});
    const first = await (await worker.fetch(req("/api/r2/items?source=legacy"), e)).json();
    assert.equal(e.LEGACY_BUCKET.reads.range, 2);
    assert.equal(first.items.find((x) => x.name === "plex-1-512.png").dimensions, "640x480");
    const second = await (await worker.fetch(req("/api/r2/items?source=legacy"), e)).json();
    assert.equal(e.LEGACY_BUCKET.reads.range, 2, "a repeat scan must not read R2 objects again");
    assert.deepEqual(second.items.map((x) => x.dimensions).sort(), ["512x512", "640x480"]);
    // A changed object (new etag) is scanned again, once.
    await e.LEGACY_BUCKET.put("apps/emby/emby-1-512.png", png(1024, 1024), {});
    await worker.fetch(req("/api/r2/items?source=legacy"), e);
    assert.equal(e.LEGACY_BUCKET.reads.range, 3);
  } finally {
    restore();
  }
});
test("Imported copies carry their dimensions, so scanning Attic needs no object reads", async () => {
  const e = env();
  const key = "apps/plex/plex-1-512.png";
  await e.LEGACY_BUCKET.put(key, png(800, 600), { httpMetadata: { contentType: "image/png" } });
  const etag = (await e.LEGACY_BUCKET.head(key)).etag;
  assert.equal((await jpost("/api/r2/import", { source: "legacy", key, etag }, e)).status, 201);
  const stored = e.GALLERY_BUCKET.items.get("imported/" + key).metadata.customMetadata;
  assert.equal(stored.width, "800");
  assert.equal(stored.height, "600");
  assert.equal(stored.originalKey, key);
  const listed = await (await worker.fetch(req("/api/r2/items?source=attic"), e)).json();
  assert.equal(listed.items[0].dimensions, "800x600");
  assert.equal(e.GALLERY_BUCKET.reads.range, 0);
  assert.equal(e.GALLERY_BUCKET.reads.full, 0);
});

test("Deleting catalogued images accepts only gallery image keys", async () => {
  const e = env();
  const keep = "gallery/apps/plex/plex-512x512-aaaaaaaa.png";
  const gone = "gallery/themes/neonpanel/plex/neonpanel-plex-512x512-bbbbbbbb.png";
  await e.GALLERY_BUCKET.put(keep, png(), {});
  await e.GALLERY_BUCKET.put(gone, png(), {});
  assert.equal(
    (await jpost("/api/gallery/delete", { keys: ["imported/apps/plex/p.png"] }, e)).status,
    400,
  );
  assert.equal(
    (await jpost("/api/gallery/delete", { keys: [gone] }, e, { origin: "https://example.com" }))
      .status,
    403,
  );
  assert.equal((await jpost("/api/gallery/delete", { keys: [] }, e)).status, 400);
  const res = await jpost("/api/gallery/delete", { keys: [gone] }, e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 1 });
  assert.equal(await e.GALLERY_BUCKET.head(gone), null);
  assert.ok(await e.GALLERY_BUCKET.head(keep));
});

test("Deleting a theme removes only that theme and requires its name as confirmation", async () => {
  const e = env();
  await e.GALLERY_BUCKET.put(
    "gallery/themes/neonpanel/plex/neonpanel-plex-512x512-aaaaaaaa.png",
    png(),
    {},
  );
  await e.GALLERY_BUCKET.put(
    "gallery/themes/neonpanel/sonarr/neonpanel-sonarr-512x512-bbbbbbbb.png",
    png(),
    {},
  );
  await e.GALLERY_BUCKET.put(
    "gallery/themes/neonpanel-2/plex/neonpanel-2-plex-512x512-cccccccc.png",
    png(),
    {},
  );
  await e.GALLERY_BUCKET.put("gallery/apps/plex/plex-512x512-dddddddd.png", png(), {});
  assert.equal((await jpost("/api/themes/delete", { theme: "neonpanel" }, e)).status, 400);
  assert.equal(
    (await jpost("/api/themes/delete", { theme: "../apps", confirm: "../apps" }, e)).status,
    400,
  );
  const res = await jpost("/api/themes/delete", { theme: "neonpanel", confirm: "neonpanel" }, e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2, theme: "neonpanel" });
  assert.deepEqual([...e.GALLERY_BUCKET.items.keys()].filter((key) => !key.includes("/_system/")).sort(), [
    "gallery/apps/plex/plex-512x512-dddddddd.png",
    "gallery/themes/neonpanel-2/plex/neonpanel-2-plex-512x512-cccccccc.png",
  ]);
  const lock = await e.GALLERY_BUCKET.get("gallery/_system/theme-locks/neonpanel.json");
  assert.equal(JSON.parse(await lock.text()).state, "released");
  assert.equal(
    (await worker.fetch(post(uploadForm("again.png", 512, 512, "themes", "Plex", "neonpanel")), e)).status,
    201,
  );
});

test("password mode: login page, wrong password, session cookie and logout", async () => {
  const e = {
    AUTH_MODE: "password",
    ADMIN_PASSWORD: "correct horse battery",
    ASSETS: { fetch: async () => new Response("<html>ok</html>") },
  };
  const at = (path, init) => worker.fetch(new Request(`http://localhost:8787${path}`, init), e);
  const home = await at("/");
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/auth/login");
  assert.equal((await at("/api/images")).status, 401);
  assert.equal((await at("/auth/login")).status, 200);

  const form = (password) => ({ method: "POST", body: new URLSearchParams({ password }) });
  assert.equal((await at("/auth/login", form("wrong"))).status, 401);
  const ok = await at("/auth/login", form("correct horse battery"));
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^attic_session=\d+\./);
  assert.equal((await at("/", { headers: { cookie } })).status, 200);
  assert.equal((await at("/", { headers: { cookie: cookie + "x" } })).status, 303);

  const out = await at("/cdn-cgi/access/logout", { headers: { cookie } });
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
});

test("Password login rate limits each client independently without exposing IP addresses", async () => {
  const e = env();
  e.AUTH_MODE = "password";
  e.ADMIN_PASSWORD = "correct horse battery";
  const login = (ip, password) => worker.fetch(req("/auth/login", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
    body: new URLSearchParams({ password }),
  }), e);
  for (let i = 0; i < 8; i++)
    assert.equal((await login("192.0.2.10", "wrong password")).status, 401);
  const limited = await login("192.0.2.10", "correct horse battery");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);

  const otherClient = await login("192.0.2.11", "wrong password");
  assert.equal(otherClient.status, 401);
  const success = await login("192.0.2.11", "correct horse battery");
  assert.equal(success.status, 303);
  const keys = [...e.GALLERY_BUCKET.items.keys()].filter((key) => key.includes("login-rate-limit/"));
  assert.equal(keys.length, 2);
  assert.ok(keys.every((key) => !key.includes("192.0.2.")));
});

test("Theme uploads are rejected while a deletion lease is active", async () => {
  const e = env();
  const lockKey = "gallery/_system/theme-locks/neonpanel.json";
  await e.GALLERY_BUCKET.put(lockKey, JSON.stringify({
    state: "deleting",
    expires: Date.now() + 60_000,
  }));
  const response = await worker.fetch(
    post(uploadForm("icon.png", 512, 512, "themes", "Plex", "neonpanel")),
    e,
  );
  assert.equal(response.status, 409);
  assert.equal(e.GALLERY_BUCKET.items.has(lockKey), true);
});

test("Malformed theme deletion leases fail closed", async () => {
  const e = env();
  const lockKey = "gallery/_system/theme-locks/neonpanel.json";
  for (const value of [
    JSON.stringify({ state: "deleting" }),
    JSON.stringify({ state: "unknown", expires: 0 }),
    "not-json",
  ]) {
    await e.GALLERY_BUCKET.put(lockKey, value);
    const response = await worker.fetch(
      post(uploadForm("icon.png", 512, 512, "themes", "Plex", "neonpanel")),
      e,
    );
    assert.equal(response.status, 409);
  }
});

test("Upload removes a stored object if post-write lease verification fails", async () => {
  const e = env();
  const lockKey = "gallery/_system/theme-locks/neonpanel.json";
  const originalGet = e.GALLERY_BUCKET.get.bind(e.GALLERY_BUCKET);
  let lockReads = 0;
  e.GALLERY_BUCKET.get = async (key, options) => {
    if (key === lockKey && ++lockReads === 2) throw new Error("simulated R2 read failure");
    return originalGet(key, options);
  };
  const response = await worker.fetch(
    post(uploadForm("icon.png", 512, 512, "themes", "Plex", "neonpanel")),
    e,
  );
  assert.equal(response.status, 503);
  assert.equal([...e.GALLERY_BUCKET.items.keys()].some((key) => key.endsWith(".png")), false);
});

test("Password login page has self-contained styling available before authentication", async () => {
  const e = env();
  e.AUTH_MODE = "password";
  e.ADMIN_PASSWORD = "correct horse battery";
  const response = await worker.fetch(req("/auth/login"), e);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<style>/);
  assert.match(response.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
});

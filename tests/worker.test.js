import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { slug, keyToImage, uploadedImageInfo } from "../src/index.js";

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
    async put(key, buffer, metadata) {
      let data;
      if (buffer?.getReader) {
        const response = new Response(buffer);
        data = new Uint8Array(await response.arrayBuffer());
      } else data = encode(buffer);
      items.set(key, {
        buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        metadata,
        etag: createHash("md5").update(data).digest("hex"),
        uploaded: new Date("2026-10-15T12:00:00Z"),
      });
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
function env(bucket = createBucket()) {
  return {
    GALLERY_BUCKET: bucket,
    LEGACY_BUCKET: createBucket(),
    ASSETS: assets,
    GALLERY_PREFIX: "gallery/",
    PUBLIC_ASSET_ORIGIN: "__PUBLIC_ORIGIN__/bilder",
    LOCAL_DEV: "true",
  };
}
function req(path = "/", opts = {}) {
  return new Request(`http://localhost${path}`, opts);
}
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
  form.set("file", new File([png(width, height)], filename, { type: "image/png" }));
  return form;
}
function post(form, extra = {}) {
  return req("/api/upload", {
    method: "POST",
    headers: { origin: "http://localhost", ...extra },
    body: form,
  });
}

test("All production requests are denied unless Access JWT is configured and verified", async () => {
  const e = env();
  delete e.LOCAL_DEV;
  const response = await worker.fetch(req("/"), e);
  assert.equal(response.status, 403);
  assert.equal((await worker.fetch(req("/api/images"), e)).status, 403);
  e.CF_ACCESS_AUD = "__CF_ACCESS_AUD__";
  e.CF_ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com";
  assert.equal(
    (
      await worker.fetch(
        req("/api/images", { headers: { "cf-access-jwt-assertion": "invalid" } }),
        e,
      )
    ).status,
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
  assert.equal(img.url, `__PUBLIC_ORIGIN__/bilder/${img.key}`);
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
test("Normalize labels and reject filepaths not controlled by the gallery", () => {
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
  assert.deepEqual(uploadedImageInfo(png(512, 512)), { width: 512, height: 512 });
  assert.equal(uploadedImageInfo(png(257, 257)), null);
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
  assert.deepEqual([...e.GALLERY_BUCKET.items.keys()].sort(), [
    "gallery/apps/plex/plex-512x512-dddddddd.png",
    "gallery/themes/neonpanel-2/plex/neonpanel-2-plex-512x512-cccccccc.png",
  ]);
});

test("Theme API rejects a JSON body that is not an object", async () => {
  const e = env();
  for (const body of [null, [], "x", 5]) {
    assert.equal((await jpost("/api/theme/preview", body, e)).status, 400);
    for (const path of ["/api/r2/import", "/api/r2/delete", "/api/gallery/delete", "/api/themes/delete"]) {
      assert.equal((await jpost(path, body, e)).status, 400, path);
    }
  }
});

test("password mode: login page, wrong password, session cookie and logout", async () => {
  const e = {
    AUTH_MODE: "password",
    ADMIN_PASSWORD: "correct horse battery",
    ASSETS: { fetch: async () => new Response("<html>ok</html>") },
  };
  const at = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.method && init.method.toUpperCase() !== "GET" && !headers.has("origin"))
      headers.set("origin", "http://localhost:8787");
    return worker.fetch(new Request(`http://localhost:8787${path}`, { ...init, headers }), e);
  };
  const home = await at("/");
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/auth/login");
  assert.equal((await at("/api/images")).status, 401);
  assert.equal((await at("/auth/login")).status, 200);

  const form = (password, origin = "http://localhost:8787") => ({ method: "POST", headers: { origin }, body: new URLSearchParams({ password }) });
  assert.equal((await at("/auth/login", form("correct horse battery", "https://attacker.example"))).status, 403);
  assert.equal((await at("/auth/login", { ...form("correct horse battery"), body: "x".repeat(8193) })).status, 413);
  assert.equal((await at("/auth/login", form("wrong"))).status, 401);
  const ok = await at("/auth/login", form("correct horse battery"));
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^attic_session=\d+\./);
  assert.equal((await at("/", { headers: { cookie } })).status, 200);
  assert.equal((await at("/", { headers: { cookie: cookie + "x" } })).status, 303);

  assert.equal((await at("/auth/logout", { method: "POST", headers: { cookie, origin: "https://attacker.example" } })).status, 403);
  const out = await at("/cdn-cgi/access/logout", { headers: { cookie } });
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
});

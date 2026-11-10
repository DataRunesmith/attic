// ZIP import for new PNG images. No arbitrary archive paths are written to R2.
// Archives are unpacked locally; existing /api/upload revalidates each image.
export const ZIP_LIMIT = 80 * 1024 * 1024;
export const ZIP_IMAGE_LIMIT = 100;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 2048;
const MAX_ENTRIES = 500;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_END = 0x06054b50;
const textDecoder = new TextDecoder("utf-8");
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

/** Read supported square PNG dimensions from a validated image header. */
export function imageDimensions(bytes) {
  if (bytes.byteLength < 33 || !pngSignature.every((v, i) => bytes[i] === v)) return null;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (d.getUint32(8) !== 13 || textDecoder.decode(bytes.subarray(12, 16)) !== "IHDR") return null;
  const width = d.getUint32(16),
    height = d.getUint32(20);
  if (![512, 1254].includes(width) || width !== height || ![0, 2, 3, 4, 6].includes(bytes[25]))
    return null;
  return `${width}x${height}`;
}
/** Normalize archive text for safe filename matching. */
function normalized(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
const GENERIC =
  /^(?:icon|ikon|bild|image|img|png|logo|cover|export|untitled|namnlos|new|ny|theme|tema|design|asset|file)(?:-\d+)?$/;
/** Derive an application hint from an image filename. */
function nameHint(filename) {
  let val = normalized(filename.replace(/\.png$/i, ""));
  val = val
    .replace(/(?:-\d{3,4}x\d{3,4}|-\d{3,4})$/, "")
    .replace(/(?:-icon|-ikon|-image|-bild|-logo)$/, "");
  return !val || GENERIC.test(val) || /^\d+$/.test(val) ? "" : val;
}
const APPS = new Set(["apps", "appar", "app", "applikationer", "applications"]);
const THEMES = new Set(["themes", "teman", "theme", "tema"]);
const IGNORE = new Set([
  "bilder",
  "images",
  "png",
  "assets",
  "ikoner",
  "icons",
  "new",
  "nya",
  "export",
  "exports",
  "output",
  "generated",
  "nybilder",
  "paket",
  "batch",
  "attic",
  "import",
  "imported",
  "zip",
  "arkiv",
  "archive",
  "samling",
  "mediesviten-14",
]);
const THEME_SUFFIX = new Set(["dark", "light", "mork", "ljus", "midnatt", "night", "day", "natt"]);
const KNOWN_APPS = new Set([
  "qui",
  "plex",
  "sonarr",
  "radarr",
  "prowlarr",
  "qbittorrent",
  "tautulli",
  "maintainerr",
  "dozzle",
  "tracearr",
  "whisparr",
  "stash",
  "stasharr",
  "seerr",
]);
export const MEDIESVITEN_APPS = [...KNOWN_APPS];
/** Identify supported image paths inside an imported ZIP entry. */
export function autodetectImagePath(path) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const file = parts.at(-1) || "";
  const basename = nameHint(file);
  const dirs = parts.slice(0, -1).map(normalized);
  let category = "apps",
    app = "",
    theme = "",
    variant = "";
  const variantIndex = dirs.findIndex((s) => s === "variants" || s === "varianter");
  if (variantIndex >= 0) variant = dirs[variantIndex + 1] || "";
  const marker = dirs.findIndex((s) => APPS.has(s) || THEMES.has(s));
  if (marker >= 0) {
    if (THEMES.has(dirs[marker])) {
      category = "themes";
      theme = dirs[marker + 1] || "";
      app = dirs[marker + 2] || basename;
      if (IGNORE.has(app) || THEMES.has(app)) app = basename;
    } else {
      category = "apps";
      app = dirs[marker + 1] || basename;
      if (IGNORE.has(app) || APPS.has(app)) app = basename;
    }
  } else {
    const structuralDirs = variantIndex >= 0 ? dirs.slice(0, variantIndex) : dirs;
    const inferredApp = structuralDirs.at(-1),
      inferredTheme = structuralDirs.at(-2);
    if (
      KNOWN_APPS.has(inferredApp) &&
      inferredTheme &&
      !IGNORE.has(inferredTheme) &&
      !APPS.has(inferredTheme)
    ) {
      category = "themes";
      theme = inferredTheme;
      app = inferredApp;
    }
    let parent = dirs.at(-1) || "";
    if (category !== "themes") app = parent && !IGNORE.has(parent) ? parent : basename;
    if ((!dirs.length || IGNORE.has(parent)) && basename) {
      // Filename convention: app-dark-512.png becomes theme dark / app.
      const bits = basename.split("-");
      const suffix = bits.at(-1);
      if (bits.length > 1 && THEME_SUFFIX.has(suffix)) {
        category = "themes";
        theme = suffix;
        app = bits.slice(0, -1).join("-");
      }
    }
  }
  if (!app || GENERIC.test(app) || IGNORE.has(app) || THEMES.has(app)) app = "";
  if (GENERIC.test(theme) || IGNORE.has(theme)) theme = "";
  if (category === "themes" && !theme) app = app || "";
  const ready =
    !!app && app.length <= 48 && (category !== "themes" || (!!theme && theme.length <= 48));
  if (variant && !theme) {
    app = "";
  }
  return { category, app, theme, variant, ready: ready && (!variant || category === "themes") };
}
// R2 keys: numbered sets like apps/plex/plex-3-512.png are one theme per number,
// so they become theme tema-3. Everything else follows the ZIP path rules.
/** Identify allowed legacy R2 image keys for import. */
export function autodetectR2Key(key) {
  const rel = key.replace(/^imported\//, "");
  const numbered = rel.match(/(?:^|\/)([a-z0-9_-]+)\/\1-(\d{1,2})(?:-\d{3,4})?\.png$/i);
  if (numbered) {
    const app = normalized(numbered[1]);
    return {
      category: "themes",
      app,
      theme: `tema-${Number(numbered[2])}`,
      variant: "",
      ready: !!app,
    };
  }
  const hint = autodetectImagePath(rel);
  // uploads/<hash>/<uuid>.png carries no app name; never catalogue it under the hash.
  const opaque = /^(?:[0-9a-f]{16,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){1,4}(?:-[0-9a-f]+)?)$/;
  if ([hint.app, hint.theme].some((v) => opaque.test(v))) return { ...hint, ready: false };
  return hint;
}
let crcTable;
/** Compute the ZIP CRC-32 checksum for an entry payload. */
function crc32(bytes) {
  if (!crcTable)
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let x = n;
      for (let j = 0; j < 8; j++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
      return x >>> 0;
    });
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// Stored (uncompressed) ZIP: PNGs are already compressed, so deflate gains nothing.
/** Assemble stored ZIP entries from the supplied file metadata and byte arrays. */
export function buildStoredZip(files) {
  const encoder = new TextEncoder();
  const local = [],
    central = [];
  let offset = 0;
  for (const { path, bytes } of files) {
    const name = encoder.encode(path),
      crc = crc32(bytes);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // UTF-8 names
    head.setUint32(14, crc, true);
    head.setUint32(18, bytes.length, true);
    head.setUint32(22, bytes.length, true);
    head.setUint16(26, name.length, true);
    local.push(head, name, bytes);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, name);
    offset += 30 + name.length + bytes.length;
  }
  const size = central.reduce((s, part) => s + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: "application/zip" });
}

/** Throw a consistent validation error for malformed ZIP archives. */
function bad(message) {
  throw new Error(message);
}
/** Reads a ZIP (stored/deflate) and returns new images plus skipped entries.
 * `inflateRaw` must accept Uint8Array and return Uint8Array (pako.inflateRaw).
 */
/** Safely parse a ZIP, enforce expansion limits, and return valid PNG image files. */
export async function readImageZip(file, inflateRaw) {
  if (!file || file.size > ZIP_LIMIT || file.size < 22)
    bad("ZIP-filen måste vara mellan 22 byte och 80 MB.");
  if (typeof inflateRaw !== "function") bad("ZIP-avkodaren kunde inte starta.");
  const buf = await file.arrayBuffer(),
    b = new Uint8Array(buf),
    dv = new DataView(buf);
  const u16 = (o) => dv.getUint16(o, true),
    u32 = (o) => dv.getUint32(o, true);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(i) === SIG_END && i + 22 + u16(i + 20) === b.length) {
      end = i;
      break;
    }
  }
  if (end < 0) bad("Detta är ingen fullständig ZIP-fil.");
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== u16(end + 10))
    bad("ZIP-filer uppdelade på flera volymer stöds inte.");
  const count = u16(end + 10),
    length = u32(end + 12),
    offset = u32(end + 16);
  if (
    count === 0 ||
    count === 65535 ||
    length === 0xffffffff ||
    offset === 0xffffffff ||
    count > MAX_ENTRIES ||
    offset + length > end
  )
    bad("ZIP-filen är för stor eller har ett format som inte stöds.");
  let pos = offset,
    total = 0,
    images = [],
    skipped = [],
    seen = new Set();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > offset + length || u32(pos) !== SIG_CENTRAL) bad("Skadad ZIP-fil (fillista).");
    const flag = u16(pos + 8),
      method = u16(pos + 10),
      crc = u32(pos + 16),
      compressed = u32(pos + 20),
      expanded = u32(pos + 24),
      filenameLength = u16(pos + 28),
      extra = u16(pos + 30),
      comment = u16(pos + 32),
      local = u32(pos + 42);
    const next = pos + 46 + filenameLength + extra + comment;
    if (next > offset + length) bad("Skadad ZIP-fil (filnamn).");
    const path = textDecoder.decode(b.subarray(pos + 46, pos + 46 + filenameLength));
    pos = next;
    if (
      !path ||
      path.includes("\u0000") ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((p) => p === ".." || p === ".") ||
      /^[A-Za-z]:/.test(path)
    )
      bad("ZIP-filen innehåller en osäker filsökväg.");
    if (path.endsWith("/")) continue;
    if (
      path.startsWith("__MACOSX/") ||
      path.split("/").some((s) => s.startsWith(".")) ||
      !path.toLowerCase().endsWith(".png")
    ) {
      skipped.push({ path, reason: "Inte en PNG-bild" });
      continue;
    }
    if (seen.has(path.toLowerCase())) {
      skipped.push({ path, reason: "Dubblettnamn" });
      continue;
    }
    seen.add(path.toLowerCase());
    if (images.length >= ZIP_IMAGE_LIMIT) {
      skipped.push({ path, reason: "Högst 100 bilder per ZIP" });
      continue;
    }
    if (flag & 1 || ![0, 8].includes(method)) {
      skipped.push({ path, reason: "Krypterad eller ej stödd ZIP-komprimering" });
      continue;
    }
    if (expanded < 33 || expanded > MAX_IMAGE_BYTES || compressed > MAX_IMAGE_BYTES) {
      skipped.push({ path, reason: "Bilden måste vara högst 12 MB" });
      continue;
    }
    if ((method === 8 && (!compressed || expanded / compressed > MAX_COMPRESSION_RATIO)) ||
        (method === 0 && compressed !== expanded)) {
      skipped.push({ path, reason: "ZIP-komprimeringsgraden är för hög eller felaktig" });
      continue;
    }
    // Count declared expansion before inflating or validating the PNG. Invalid
    // PNG payloads must consume the same budget as valid images.
    if (total + expanded > MAX_EXPANDED_BYTES)
      bad("ZIP-filen innehåller mer än 64 MB bilder. Dela upp den.");
    total += expanded;
    if (local + 30 > b.length || u32(local) !== SIG_LOCAL) bad("Skadad ZIP-fil (fildata).");
    if (u16(local + 8) !== method || u16(local + 6) & 1)
      bad("ZIP-filen har motstridiga filuppgifter.");
    const dataOffset = local + 30 + u16(local + 26) + u16(local + 28);
    if (dataOffset + compressed > offset || dataOffset + compressed > b.length)
      bad("Skadad ZIP-fil (komprimerad data).");
    const raw = b.subarray(dataOffset, dataOffset + compressed);
    let out;
    try {
      out = method === 0 ? raw : inflateRaw(raw, expanded);
    } catch {
      skipped.push({ path, reason: "Kunde inte packa upp bilden" });
      continue;
    }
    if (!(out instanceof Uint8Array) || out.byteLength !== expanded || crc32(out) !== crc) {
      skipped.push({ path, reason: "Bilden är skadad (CRC/storlek)" });
      continue;
    }
    const size = imageDimensions(out);
    if (!size) {
      skipped.push({ path, reason: "Kräver PNG i 512×512 eller 1254×1254" });
      continue;
    }
    const hint = autodetectImagePath(path);
    const name = path.split("/").at(-1);
    images.push({
      path,
      file: new File([out], name, { type: "image/png" }),
      size,
      bytes: expanded,
      ...hint,
    });
  }
  if (!images.length)
    bad("ZIP-filen innehåller inga giltiga PNG-bilder i 512×512 eller 1254×1254.");
  // A ZIP with a wrapping batch folder may contain several unrelated app images.
  // Prefer each filename over the shared folder when they clearly identify different apps.
  const dirs = images.map((x) => x.path.split("/").slice(0, -1));
  const wrapper = dirs.length > 1 && dirs.every((x) => x.length === 1 && x[0] === dirs[0][0]);
  if (wrapper && !APPS.has(normalized(dirs[0][0])) && !THEMES.has(normalized(dirs[0][0]))) {
    const hints = images.map((x) => nameHint(x.file.name));
    if (new Set(hints.filter(Boolean)).size > 1) {
      images = images.map((x, i) => ({ ...x, ...autodetectImagePath(x.file.name) }));
    }
  }
  return { images, skipped };
}

// A theme folder that is missing or only says "tema"/"untitled" takes its name
// from the ZIP file instead, so Neon.zip with tema/plex/... becomes theme neon.
/** Derive a normalized theme name from an archive filename. */
export function themeNameFromZip(filename) {
  const name = normalized(String(filename || "").replace(/\.zip$/i, ""));
  return !name || GENERIC.test(name) || /^\d+$/.test(name) ? "" : name;
}
/** Fill absent theme labels using the archive's normalized name. */
export function fillMissingThemes(images, zipName) {
  const fallback = themeNameFromZip(zipName);
  if (!fallback) return images;
  return images.map((x) =>
    x.category === "themes" && !x.theme ? { ...x, theme: fallback, ready: !!x.app } : x,
  );
}

/** Validate and normalize image entries before creating an import archive. */
export function validateMediesviten(images) {
  const missing = [];
  for (const app of MEDIESVITEN_APPS) {
    for (const size of ["512x512", "1254x1254"]) {
      if (
        !images.some(
          (x) =>
            x.selected !== false &&
            x.category === "themes" &&
            x.app === app &&
            !x.variant &&
            x.size === size,
        )
      )
        missing.push(`${app} ${size}`);
    }
  }
  const themeNames = new Set(
    images.filter((x) => x.selected !== false && x.category === "themes").map((x) => x.theme),
  );
  return {
    valid: missing.length === 0 && themeNames.size === 1,
    missing,
    themeNames: [...themeNames],
  };
}

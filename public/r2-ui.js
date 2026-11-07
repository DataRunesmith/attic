// Privately scoped R2 explorer. No public listing, no automatic deletion or move.
import { autodetectR2Key, imageDimensions } from "./zip-import.js";

const $ = (id) => document.getElementById(id);
const state = {
  source: "legacy",
  items: [],
  scanned: {},
  selected: new Set(),
  loading: false,
  busy: false,
  dimensionSelection: null,
  formatSelection: null,
  requestId: 0,
  controller: null,
};
const err = (message) => {
  $("r2-error").textContent = message;
  $("r2-error").classList.toggle("hidden", !message);
};
const formatSize = (n) =>
  n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const validSource = (s) => ["legacy", "attic"].includes(s);
function previewUrl(key) {
  const q = new URLSearchParams({ source: state.source, key });
  return `/api/r2/preview?${q}`;
}
function dimensionKey(item) {
  return item.dimensions || "unknown";
}
function fileFormat(item) {
  return item.format || "Okänt";
}
function visibleItems() {
  const folder = $("r2-folder").value,
    search = $("r2-search").value.trim().toLowerCase();
  const list = state.items.filter(
    (o) =>
      (!folder || o.folder === folder || o.folder.startsWith(folder + "/")) &&
      (!search || o.key.toLowerCase().includes(search)) &&
      (state.dimensionSelection === null || state.dimensionSelection.has(dimensionKey(o))) &&
      (state.formatSelection === null || state.formatSelection.has(fileFormat(o))),
  );
  const mode = $("r2-sort").value;
  const pixels = (o) => (o.width > 0 && o.height > 0 ? o.width * o.height : null);
  return list.sort((a, b) => {
    if (mode === "bytes-desc") return b.size - a.size || a.key.localeCompare(b.key, "sv");
    if (mode === "bytes-asc") return a.size - b.size || a.key.localeCompare(b.key, "sv");
    if (mode.startsWith("pixels-")) {
      const x = pixels(a),
        y = pixels(b);
      if (x === null) return y === null ? a.key.localeCompare(b.key, "sv") : 1;
      if (y === null) return -1;
      return (mode === "pixels-desc" ? y - x : x - y) || a.key.localeCompare(b.key, "sv");
    }
    return a.key.localeCompare(b.key, "sv");
  });
}
function optionGroup(target, counts, field) {
  const el = $(target);
  el.replaceChildren();
  const selected = state[field];
  const values = [...counts.keys()].sort((a, b) => {
    if (field === "dimensionSelection") {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      const area = (v) =>
        v
          .split("x")
          .map(Number)
          .reduce((x, y) => x * y, 1);
      return area(b) - area(a) || a.localeCompare(b, "sv");
    }
    return a.localeCompare(b, "sv");
  });
  for (const value of values) {
    const label = document.createElement("label");
    label.className = "r2-check-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected === null || selected.has(value);
    const caption = document.createElement("span");
    caption.textContent = `${field === "dimensionSelection" ? (value === "unknown" ? "Okända mått" : value.replace("x", " × ")) : value} (${counts.get(value)})`;
    input.addEventListener("change", () => {
      if (state[field] === null) state[field] = new Set(values);
      if (input.checked) state[field].add(value);
      else state[field].delete(value);
      render();
    });
    label.append(input, caption);
    el.append(label);
  }
  if (!values.length) {
    const span = document.createElement("span");
    span.textContent = "Inga bilder hittades.";
    el.append(span);
  }
}
function renderFilterOptions() {
  const dim = new Map(),
    formats = new Map();
  for (const o of state.items) {
    const k = dimensionKey(o),
      fmt = fileFormat(o);
    dim.set(k, (dim.get(k) || 0) + 1);
    formats.set(fmt, (formats.get(fmt) || 0) + 1);
  }
  optionGroup("r2-dimension-options", dim, "dimensionSelection");
  optionGroup("r2-format-options", formats, "formatSelection");
  const unknown = dim.get("unknown") || 0;
  $("r2-scan-status").textContent =
    `${state.items.length} bilder skannade · ${dim.size} upptäckta bildstorlekar · ${formats.size} bildformat` +
    (unknown ? ` · ${unknown} med okända mått` : "");
}

function updateActions() {
  const count = state.selected.size;
  $("r2-delete").disabled = state.busy || state.loading || count === 0;
  const catalog = $("r2-catalog").checked;
  $("r2-import").disabled =
    state.busy || state.loading || (state.source !== "legacy" && !catalog) || count === 0;
  $("r2-delete").textContent = `Radera markerade (${count})`;
  $("r2-import").textContent = `${catalog ? "Katalogisera" : "Importera"} i Attic (${count})`;
  $("r2-count").textContent =
    `${state.items.length} bilder · ${visibleItems().length} visas · ${count} markerade`;
  $("r2-select-all").disabled = state.loading || state.busy;
  $("r2-unselect").disabled = state.loading || state.busy || count === 0;
  $("r2-reload").disabled = state.loading || state.busy;
  $("r2-source").disabled = state.busy;
}
function folderOptions() {
  const folders = [...new Set(state.items.map((x) => x.folder))].sort((a, b) =>
    a.localeCompare(b, "sv"),
  );
  $("r2-folder").replaceChildren(
    new Option("Alla mappar", ""),
    ...folders.map((folder) => new Option(folder, folder)),
  );
}
function render() {
  const container = $("r2-images");
  container.replaceChildren();
  for (const item of visibleItems()) {
    const selected = state.selected.has(item.key);
    const card = document.createElement("article");
    card.className = "r2-card";
    const link = document.createElement("a");
    link.className = "r2-picture";
    link.href = previewUrl(item.key);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Öppna förhandsvisning";
    const img = document.createElement("img");
    img.src = link.href;
    img.loading = "lazy";
    img.alt = `Förhandsvisning av ${item.name}`;
    link.append(img);
    const label = document.createElement("label");
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = selected;
    tick.disabled = state.busy;
    const title = document.createElement("span");
    title.textContent = item.name;
    label.append(tick, title);
    tick.addEventListener("change", () => {
      if (tick.checked) state.selected.add(item.key);
      else state.selected.delete(item.key);
      updateActions();
    });
    const path = document.createElement("div");
    path.className = "r2-path";
    path.textContent = item.folder;
    const meta = document.createElement("div");
    meta.className = "r2-meta";
    meta.textContent = `${item.dimensions ? item.dimensions.replace("x", " × ") + " px" : "Okända mått"} · ${fileFormat(item)} · ${formatSize(item.size)}`;
    card.append(link, label, path, meta);
    container.append(card);
  }
  if (!container.children.length) {
    const p = document.createElement("p");
    p.className = "r2-notice";
    p.textContent = "Inga bilder i denna mapp eller sökning.";
    container.append(p);
  }
  updateActions();
}
// Scans a source once per page session; reopening or switching back reuses the result.
// Only the reload button forces a new scan of the bucket.
function showScanned(source) {
  state.items = state.scanned[source];
  state.selected.clear();
  state.dimensionSelection = null;
  state.formatSelection = null;
  err("");
  $("r2-progress").textContent = "";
  folderOptions();
  renderFilterOptions();
  render();
}
async function load(force = false) {
  if (state.busy) return;
  if (!force && state.scanned[state.source]) {
    if (state.controller) state.controller.abort();
    state.requestId++;
    state.loading = false;
    state.controller = null;
    showScanned(state.source);
    return;
  }
  const id = ++state.requestId;
  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;
  state.loading = true;
  state.selected.clear();
  state.dimensionSelection = null;
  state.formatSelection = null;
  err("");
  $("r2-progress").textContent = "Skannar bildstorlekar i R2…";
  $("r2-scan-status").textContent = "Skanningen pågår…";
  updateActions();
  const source = state.source,
    items = [];
  let cursor = null,
    page = 0;
  try {
    do {
      const q = new URLSearchParams({ source });
      if (cursor) q.set("cursor", cursor);
      const res = await fetch(`/api/r2/items?${q}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok)
        throw new Error(
          res.status === 403 ? "Din inloggning behöver förnyas." : "Kunde inte skanna R2-filerna.",
        );
      const data = await res.json();
      if (!Array.isArray(data.items)) throw new Error("Felaktigt svar från bildskannern.");
      if (id !== state.requestId) return;
      items.push(...data.items);
      cursor = data.cursor || null;
      $("r2-progress").textContent = `Skannar bildstorlekar… ${items.length} bilder kontrollerade`;
      if (++page > 400) throw new Error("Arkivet är för stort för en enda skanning.");
    } while (cursor && source === state.source);
    if (id === state.requestId && source === state.source) {
      state.scanned[source] = items;
      state.items = items;
      folderOptions();
      renderFilterOptions();
      render();
      $("r2-progress").textContent = "";
    }
  } catch (e) {
    if (id === state.requestId && e.name !== "AbortError") {
      err(e.message);
      $("r2-progress").textContent = "Skanningen avbröts.";
    }
  } finally {
    if (id === state.requestId) {
      state.loading = false;
      state.controller = null;
      updateActions();
    }
  }
}

async function perform(endpoint, item, confirmation) {
  const res = await fetch(`/api/r2/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      source: state.source,
      key: item.key,
      etag: item.etag,
      ...(confirmation ? { confirm: confirmation } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${item.name}: ${data.error || `HTTP ${res.status}`}`);
  return data;
}
// Identify app, theme and resolution, then save the image straight into the
// catalogue through /api/upload. From attic's imported/ the original is removed
// afterwards; anything unidentified is copied unchanged (legacy) or left alone.
async function catalogue(item) {
  const hint = autodetectR2Key(item.key);
  if (hint.ready) {
    const res = await fetch(previewUrl(item.key), { cache: "no-store" });
    if (!res.ok) throw new Error(`${item.name}: kunde inte läsas`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (imageDimensions(bytes)) {
      const form = new FormData();
      form.set("category", hint.category);
      form.set("app", hint.app);
      form.set("theme", hint.category === "themes" ? hint.theme : "");
      form.set("variant", hint.category === "themes" ? hint.variant : "");
      form.set("file", new File([bytes], "bild.png", { type: "image/png" }));
      const up = await fetch("/api/upload", { method: "POST", body: form });
      const data = await up.json().catch(() => ({}));
      if (!up.ok) throw new Error(`${item.name}: ${data.error || `HTTP ${up.status}`}`);
      if (state.source === "attic") await perform("delete", item, "RADERA");
      return "catalogued";
    }
  }
  if (state.source === "legacy") {
    await perform("import", item);
    return "copied";
  }
  throw new Error(`${item.name}: kunde inte identifieras`);
}
async function process(action) {
  if (state.busy || state.loading) return;
  const items = state.items.filter((x) => state.selected.has(x.key));
  if (!items.length) return;
  const catalog = action === "import" && $("r2-catalog").checked;
  if (action === "import" && state.source !== "legacy" && !catalog) return;
  if (action === "delete") {
    const location = state.source === "legacy" ? "__LEGACY_BUCKET__" : "__GALLERY_BUCKET__";
    if (!window.confirm(`Radera ${items.length} bild(er) i ${location}? Det går inte att ångra.`))
      return;
  }
  state.busy = true;
  err("");
  updateActions();
  render();
  let ok = 0,
    copied = 0,
    fail = 0;
  const errors = [];
  const deleted = new Set();
  for (const [idx, item] of items.entries()) {
    $("r2-progress").textContent =
      `${catalog ? "Katalogiserar" : action === "import" ? "Importerar" : "Raderar"} ${idx + 1}/${items.length}: ${item.name}`;
    try {
      if (catalog) {
        if ((await catalogue(item)) === "copied") copied++;
        else ok++;
        if (state.source === "attic") deleted.add(item.key);
      } else {
        await perform(action, item, action === "delete" ? "RADERA" : undefined);
        ok++;
        if (action === "delete") deleted.add(item.key);
      }
      state.selected.delete(item.key);
    } catch (e) {
      fail++;
      errors.push(e.message);
    }
  }
  state.busy = false;
  // Apply the confirmed results locally instead of rescanning the whole bucket.
  // The server verifies every delete, and imports never change the source list.
  if (action === "import" && (ok || copied)) {
    if (state.source !== "attic") delete state.scanned.attic; // new copies appear on the next visit
    if (ok) window.dispatchEvent(new Event("attic:zip-updated"));
  }
  if (deleted.size) {
    state.items = state.items.filter((x) => !deleted.has(x.key));
    state.scanned[state.source] = state.items;
    const folder = $("r2-folder").value;
    folderOptions();
    if ([...$("r2-folder").options].some((x) => x.value === folder)) $("r2-folder").value = folder;
    renderFilterOptions();
  }
  render();
  if (errors.length) err(errors.slice(0, 4).join(" · "));
  $("r2-progress").textContent = catalog
    ? `${ok} katalogiserade, ${copied} oidentifierade kopierade till imported/, ${fail} misslyckades.`
    : `${ok} ${action === "import" ? "kopierade" : "raderade"}, ${fail} misslyckades. ${action === "import" ? "Originalen ligger kvar i __LEGACY_BUCKET__." : ""}`;
}
function open() {
  $("sidebar").classList.remove("open");
  $("mobile-scrim").hidden = true;
  $("r2-dialog").showModal();
  load(false);
}
for (const b of document.querySelectorAll("[data-open-r2]")) b.addEventListener("click", open);
$("r2-close").addEventListener("click", () => $("r2-dialog").close());
$("r2-dialog").addEventListener("click", (e) => {
  if (e.target === $("r2-dialog") && !state.busy) $("r2-dialog").close();
});
$("r2-dialog").addEventListener("cancel", (e) => {
  if (state.busy) e.preventDefault();
});
$("r2-source").addEventListener("change", (e) => {
  if (!validSource(e.target.value)) return;
  state.source = e.target.value;
  load(false);
});
$("r2-folder").addEventListener("change", render);
$("r2-search").addEventListener("input", render);
$("r2-select-all").addEventListener("click", () => {
  for (const x of visibleItems()) state.selected.add(x.key);
  render();
});
$("r2-unselect").addEventListener("click", () => {
  state.selected.clear();
  render();
});
$("r2-reload").addEventListener("click", () => load(true));
$("r2-import").addEventListener("click", () => process("import"));
$("r2-catalog").addEventListener("change", updateActions);
$("r2-delete").addEventListener("click", () => process("delete"));

$("r2-sort").addEventListener("change", render);
$("r2-reset-filters").addEventListener("click", () => {
  state.dimensionSelection = null;
  state.formatSelection = null;
  renderFilterOptions();
  render();
});

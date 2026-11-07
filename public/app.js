import { showThemes } from "./theme-library.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["bilder", "teman"];
const state = {
  images: [],
  view: "bilder",
  layout: "grid",
  search: "",
  app: "all",
  theme: "all",
  size: "all",
  sort: "newest",
  pending: null,
  objectUrl: null,
  loading: false,
  moving: null,
};
let toastTimeout;
const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
};
function toast(msg) {
  clearTimeout(toastTimeout);
  $("toast").textContent = msg;
  $("toast").classList.add("visible");
  toastTimeout = setTimeout(() => $("toast").classList.remove("visible"), 2600);
}
function readableSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function niceName(name) {
  return (name || "").replace(/-/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
}
async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Serverfel ${response.status}`);
  return data;
}

function displayedImages() {
  let images = state.images;
  if (state.app !== "all") images = images.filter((i) => i.app === state.app);
  if (state.theme === "none") images = images.filter((i) => !i.theme);
  else if (state.theme !== "all") images = images.filter((i) => i.theme === state.theme);
  if (state.size !== "all") images = images.filter((i) => i.dimensions === state.size);
  if (state.search.trim()) {
    const term = state.search.toLocaleLowerCase("sv");
    images = images.filter((i) =>
      [i.app, i.name, i.theme, i.variant, i.dimensions].some((v) =>
        String(v || "")
          .toLocaleLowerCase("sv")
          .includes(term),
      ),
    );
  }
  return [...images].sort((a, b) => {
    if (state.sort === "name") return (a.app + a.name).localeCompare(b.app + b.name, "sv");
    if (state.sort === "name-desc") return (b.app + b.name).localeCompare(a.app + a.name, "sv");
    if (state.sort === "size-desc") return b.bytes - a.bytes;
    if (state.sort === "size-asc") return a.bytes - b.bytes;
    return String(b.uploaded).localeCompare(String(a.uploaded));
  });
}

function fillSelect(select, fixed, values, current) {
  select.replaceChildren(
    ...fixed.map(([value, label]) => new Option(label, value)),
    ...values.map((v) => new Option(niceName(v), v)),
  );
  select.value = [...fixed.map(([v]) => v), ...values].includes(current) ? current : "all";
  return select.value;
}
function renderFilters() {
  const apps = [...new Set(state.images.map((x) => x.app))].sort((a, b) =>
    a.localeCompare(b, "sv"),
  );
  const themes = [...new Set(state.images.map((x) => x.theme).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "sv"),
  );
  state.app = fillSelect($("app-filter"), [["all", "Alla appar"]], apps, state.app);
  state.theme = fillSelect(
    $("theme-filter"),
    [
      ["all", "Alla teman"],
      ["none", "Utan tema"],
    ],
    themes,
    state.theme,
  );
  $("known-apps").replaceChildren(...apps.map((v) => new Option(v)));
  $("known-themes").replaceChildren(...themes.map((v) => new Option(v)));
}
function renderStats() {
  const themes = new Set(state.images.filter((x) => x.theme).map((x) => x.theme));
  $("stat-total").textContent = state.images.length;
  $("stat-apps").textContent = new Set(state.images.map((x) => x.app)).size;
  $("stat-themes").textContent = themes.size;
  const mbs = state.images.reduce((s, v) => s + Number(v.bytes || 0), 0) / (1024 * 1024);
  $("stat-storage").innerHTML =
    `${mbs < 0.1 && mbs !== 0 ? mbs.toFixed(2) : mbs.toFixed(1)} <span>MB</span>`;
  $("nav-all-count").textContent = state.images.length;
  $("nav-theme-count").textContent = themes.size;
}

function actionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}
// Image URLs come from the API; only http(s) URLs reach an img element.
function imageUrl(value) {
  try {
    const url = new URL(String(value || ""), location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}
function createCard(item) {
  const card = document.createElement("article");
  card.className = "image-card";
  const visual = document.createElement("div");
  visual.className = "image-visual";
  const img = document.createElement("img");
  img.src = imageUrl(item.url);
  img.alt = `Bild: ${item.app}`;
  img.loading = "lazy";
  visual.append(img);
  const cat = document.createElement("span");
  cat.className = "image-category";
  cat.textContent = item.theme ? niceName(item.theme) : "Appikon";
  visual.append(cat);
  const info = document.createElement("div");
  info.className = "image-info";
  const label = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = niceName(item.app) + (item.variant ? " · " + niceName(item.variant) : "");
  const sub = document.createElement("p");
  sub.textContent = `${item.dimensions.replace("x", " × ")} · ${readableSize(item.bytes)}`;
  label.append(strong, sub);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.innerHTML = `${icons.copy}<span>Kopiera länk</span>`;
  copy.setAttribute("aria-label", `Kopiera bildlänk för ${item.app}`);
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(item.url);
      toast("Bildlänken kopierad!");
    } catch {
      toast("Kunde inte kopiera länken.");
    }
  });
  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.append(
    actionButton("Flytta", "card-action", () => openMove(item)),
    actionButton("Radera", "card-action danger", () => deleteImage(item)),
  );
  info.append(label, copy, actions);
  card.append(visual, info);
  return card;
}

function render() {
  renderStats();
  renderFilters();
  const images = displayedImages();
  $("results-label").textContent = `${images.length} ${images.length === 1 ? "bild" : "bilder"}`;
  $("gallery").replaceChildren(...images.map(createCard));
  $("gallery").className = `gallery ${state.layout === "list" ? "list-layout" : "grid-layout"}`;
  document.querySelectorAll("[data-layout]").forEach((x) => {
    x.classList.toggle("selected", x.dataset.layout === state.layout);
    x.setAttribute("aria-pressed", String(x.dataset.layout === state.layout));
  });
  const empty = images.length === 0;
  $("empty-state").classList.toggle("hidden", !empty);
  if (empty) {
    const filtered =
      !!state.search.trim() || state.size !== "all" || state.app !== "all" || state.theme !== "all";
    $("empty-title").textContent = filtered
      ? "Inga bilder matchar filtren"
      : "Här börjar din samling";
    $("empty-description").textContent = filtered
      ? "Ändra app, tema eller upplösning för att se fler bilder."
      : "Arkivet väntar på sin första bild. Ladda upp en PNG eller en ZIP, så ordnar Attic resten.";
    $("empty-upload").classList.toggle("hidden", filtered);
  }
}

function setView(view) {
  if (!VIEWS.includes(view)) view = "bilder";
  state.view = view;
  const titles = {
    bilder: ["Dina bilder.", "Allt på sin plats."],
    teman: ["Dina teman.", "Samma känsla."],
  };
  $("page-title").replaceChildren(document.createTextNode(titles[view][0] + " "));
  const accent = document.createElement("span");
  accent.textContent = titles[view][1];
  $("page-title").append(accent);
  $("page-description").textContent =
    view === "teman"
      ? "Använd ett tema i App Launcher, ladda ner det som ZIP eller radera det."
      : "Filtrera på app, tema och upplösning. Flytta eller radera enskilda bilder.";
  document.querySelector(".library-section").hidden = view !== "bilder";
  document.querySelector(".stats-grid").hidden = view !== "bilder";
  $("theme-library").hidden = view !== "teman";
  document.querySelectorAll("[data-view]").forEach((x) => {
    x.classList.toggle("active", x.dataset.view === view);
    if (x.dataset.view === view) x.setAttribute("aria-current", "page");
    else x.removeAttribute("aria-current");
  });
  $("sidebar").classList.remove("open");
  $("mobile-scrim").hidden = true;
  render();
}
function showImagesFor(filters) {
  Object.assign(state, { app: "all", theme: "all", size: "all", search: "" }, filters);
  $("search").value = "";
  location.hash = "bilder";
  setView("bilder");
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("error-banner").classList.add("hidden");
  try {
    const next = [];
    let cursor = null;
    let page = 0;
    do {
      const path = "/api/images" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "");
      const response = await fetch(path, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "Du saknar behörighet till bildarkivet."
            : "Kunde inte läsa bildarkivet.",
        );
      const data = await response.json();
      if (!Array.isArray(data.images)) throw new Error("Ogiltigt svar från servern.");
      next.push(...data.images);
      cursor = data.cursor;
      page++;
      if (page > 50) throw new Error("För många sidor i arkivet.");
    } while (cursor);
    state.images = next;
    showThemes(next);
  } catch (err) {
    $("error-banner").textContent = `${err.message} Kontrollera anslutningen och prova igen.`;
    $("error-banner").classList.remove("hidden");
  } finally {
    state.loading = false;
    render();
  }
}

async function deleteImage(item) {
  const label = `${niceName(item.app)}${item.theme ? " i " + niceName(item.theme) : ""} (${item.dimensions})`;
  if (!confirm(`Radera ${label}? Det går inte att ångra.`)) return;
  try {
    await postJson("/api/gallery/delete", { keys: [item.key] });
    toast("Bilden är raderad.");
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

// Moving re-uploads the image under its new app/theme/variant (so it gets a
// canonical key) and only then deletes the old object.
export async function moveImage(item, target) {
  const source = await fetch(item.url, { cache: "no-store" });
  if (!source.ok) throw new Error("Kunde inte läsa bilden.");
  const blob = await source.blob();
  const data = new FormData();
  data.set("category", target.theme ? "themes" : "apps");
  data.set("app", target.app);
  data.set("theme", target.theme || "");
  data.set("variant", target.theme ? target.variant || "" : "");
  data.set("file", new File([blob], "bild.png", { type: "image/png" }));
  const response = await fetch("/api/upload", { method: "POST", body: data });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Kunde inte spara bilden på nya platsen.");
  await postJson("/api/gallery/delete", { keys: [item.key] });
  return result.image;
}
function openMove(item) {
  state.moving = item;
  $("move-image").src = imageUrl(item.url);
  $("move-app").value = item.app;
  $("move-theme").value = item.theme || "";
  $("move-variant").value = item.variant || "";
  $("move-error").classList.add("hidden");
  $("move-dialog").showModal();
  $("move-app").focus();
}
async function submitMove(event) {
  event.preventDefault();
  const item = state.moving;
  if (!item) return;
  const target = {
    app: $("move-app").value.trim(),
    theme: $("move-theme").value.trim(),
    variant: $("move-variant").value.trim(),
  };
  if (!target.app) return;
  $("move-submit").disabled = true;
  try {
    await moveImage(item, target);
    $("move-dialog").close();
    toast("Bilden är flyttad.");
    await refresh();
  } catch (err) {
    $("move-error").textContent = err.message;
    $("move-error").classList.remove("hidden");
  } finally {
    $("move-submit").disabled = false;
  }
}

function openUpload() {
  $("upload-form").reset();
  $("upload-error").classList.add("hidden");
  clearFile();
  $("upload-category").value = state.theme !== "all" && state.theme !== "none" ? "themes" : "apps";
  if ($("upload-category").value === "themes") $("upload-theme").value = state.theme;
  updateCategory();
  $("upload-dialog").showModal();
  $("upload-app").focus();
}
function closeUpload() {
  $("upload-dialog").close();
  clearFile();
}
function updateCategory() {
  $("theme-field").classList.toggle("hidden", $("upload-category").value !== "themes");
  updateSubmit();
}
function clearFile() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  state.pending = null;
  $("drop-placeholder").classList.remove("hidden");
  $("drop-preview").classList.add("hidden");
  $("file-label").textContent = "PNG · 512 × 512 eller 1254 × 1254 · Max 12 MB";
  $("submit-upload").disabled = true;
  $("upload-file").value = "";
}
function showUploadError(message) {
  $("upload-error").textContent = message;
  $("upload-error").classList.remove("hidden");
}
function updateSubmit() {
  const themeOK = $("upload-category").value !== "themes" || !!$("upload-theme").value.trim();
  $("submit-upload").disabled = !(state.pending && $("upload-app").value.trim() && themeOK);
}
function setFile(file) {
  clearFile();
  $("upload-error").classList.add("hidden");
  if (!file) return;
  if (file.type !== "image/png" || !file.name.toLowerCase().endsWith(".png"))
    return showUploadError("Välj en PNG-bild.");
  if (file.size > 12 * 1024 * 1024) return showUploadError("Bilden får vara högst 12 MB.");
  const objectUrl = URL.createObjectURL(file);
  state.objectUrl = objectUrl;
  const img = new Image();
  img.onload = () => {
    if (!state.objectUrl || state.objectUrl !== objectUrl) return;
    if (img.naturalWidth !== img.naturalHeight || ![512, 1254].includes(img.naturalWidth))
      return showUploadError("Bilden måste vara 512 × 512 eller 1254 × 1254 pixlar.");
    state.pending = file;
    $("preview-image").src = objectUrl;
    $("drop-placeholder").classList.add("hidden");
    $("drop-preview").classList.remove("hidden");
    $("file-label").textContent =
      `${file.name} · ${img.naturalWidth} × ${img.naturalHeight} · ${readableSize(file.size)}`;
    updateSubmit();
  };
  img.onerror = () => showUploadError("Det gick inte att läsa bilden.");
  img.src = objectUrl;
}
async function upload(event) {
  event.preventDefault();
  if (!state.pending) return;
  const button = $("submit-upload");
  button.disabled = true;
  $("submit-text").textContent = "Sparar…";
  $("upload-error").classList.add("hidden");
  const data = new FormData();
  data.set("category", $("upload-category").value);
  data.set("app", $("upload-app").value.trim());
  data.set("theme", $("upload-category").value === "themes" ? $("upload-theme").value.trim() : "");
  data.set("file", state.pending, state.pending.name);
  try {
    const response = await fetch("/api/upload", { method: "POST", body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Kunde inte spara bilden.");
    closeUpload();
    toast("Bilden är sparad i arkivet!");
    await refresh();
  } catch (err) {
    showUploadError(err.message);
  } finally {
    $("submit-text").textContent = "Spara bild";
    updateSubmit();
  }
}

function init() {
  document.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      location.hash = b.dataset.view;
      setView(b.dataset.view);
    }),
  );
  window.addEventListener("hashchange", () => setView(location.hash.slice(1) || "bilder"));
  document.querySelectorAll("[data-layout]").forEach((b) =>
    b.addEventListener("click", () => {
      state.layout = b.dataset.layout;
      render();
    }),
  );
  $("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });
  for (const [id, key] of [
    ["app-filter", "app"],
    ["theme-filter", "theme"],
    ["size-filter", "size"],
    ["sort-filter", "sort"],
  ])
    $(id).addEventListener("change", (e) => {
      state[key] = e.target.value;
      render();
    });
  ["sidebar-upload", "upload-main", "empty-upload"].forEach((id) =>
    $(id).addEventListener("click", openUpload),
  );
  ["close-dialog", "cancel-dialog"].forEach((id) => $(id).addEventListener("click", closeUpload));
  $("upload-dialog").addEventListener("click", (e) => {
    if (e.target === $("upload-dialog")) closeUpload();
  });
  $("upload-dialog").addEventListener("close", clearFile);
  $("upload-category").addEventListener("change", updateCategory);
  ["upload-app", "upload-theme"].forEach((id) => $(id).addEventListener("input", updateSubmit));
  $("upload-form").addEventListener("submit", upload);
  $("move-form").addEventListener("submit", submitMove);
  ["move-close", "move-cancel"].forEach((id) =>
    $(id).addEventListener("click", () => $("move-dialog").close()),
  );
  $("drop-zone").addEventListener("click", () => $("upload-file").click());
  $("drop-zone").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("upload-file").click();
    }
  });
  $("upload-file").addEventListener("change", (e) => setFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((name) =>
    $("drop-zone").addEventListener(name, (e) => {
      e.preventDefault();
      $("drop-zone").classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((name) =>
    $("drop-zone").addEventListener(name, (e) => {
      e.preventDefault();
      $("drop-zone").classList.remove("dragging");
    }),
  );
  $("drop-zone").addEventListener("drop", (e) => {
    if (e.dataTransfer.files?.length) setFile(e.dataTransfer.files[0]);
  });
  $("refresh-top").addEventListener("click", () => {
    toast("Uppdaterar bildarkivet…");
    refresh();
  });
  $("mobile-menu").addEventListener("click", () => {
    $("sidebar").classList.toggle("open");
    $("mobile-scrim").hidden = !$("sidebar").classList.contains("open");
  });
  $("mobile-scrim").addEventListener("click", () => {
    $("sidebar").classList.remove("open");
    $("mobile-scrim").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("search").focus();
    }
    if (e.key === "Escape" && $("sidebar").classList.contains("open")) {
      $("sidebar").classList.remove("open");
      $("mobile-scrim").hidden = true;
    }
  });
  window.addEventListener("attic:zip-updated", refresh);
  window.addEventListener("attic:show-images", (e) => showImagesFor(e.detail || {}));
  setView(location.hash.slice(1) || "bilder");
  refresh();
}
init();

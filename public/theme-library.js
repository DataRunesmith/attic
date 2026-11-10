// Theme cards: show a theme's images, use it in App Launcher, download it as a
// ZIP or delete it. The ZIP uses the same themes/<tema>/<app>/ layout that the
// ZIP import recognises, so a downloaded theme can be imported again as is.
import { buildStoredZip } from "./zip-import.js";

const $ = (id) => document.getElementById(id);
const SIZES = ["512x512", "1254x1254"];
let images = [];
let busy = false;

const niceName = (name) => (name || "").replace(/-/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
/** Show a transient theme-library status message. */
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  setTimeout(() => $("toast").classList.remove("visible"), 2600);
}
/** Create a button with the shared theme-library interaction styling. */
function button(label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/** Derive a safe archive path for one selected theme image. */
function zipPath(image) {
  return [
    "themes",
    image.theme,
    image.app,
    ...(image.variant ? ["variants", image.variant] : []),
    image.name,
  ].join("/");
}
/** Download selected theme images as an archive and restore UI state on completion. */
async function download(theme, sizes, trigger) {
  const chosen = images.filter((x) => x.theme === theme && sizes.includes(x.dimensions));
  if (!chosen.length) return toast("Välj minst en upplösning som temat har.");
  busy = true;
  trigger.disabled = true;
  try {
    const files = [];
    for (const [i, image] of chosen.entries()) {
      trigger.textContent = `Hämtar ${i + 1}/${chosen.length}…`;
      const response = await fetch(image.url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Kunde inte hämta ${image.name}.`);
      files.push({ path: zipPath(image), bytes: new Uint8Array(await response.arrayBuffer()) });
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(buildStoredZip(files));
    link.download = `${theme}${sizes.length === 1 ? "-" + sizes[0] : ""}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } catch (err) {
    toast(err.message);
  } finally {
    busy = false;
    trigger.disabled = false;
    trigger.textContent = "Ladda ner ZIP";
  }
}

/** Delete a theme and refresh dependent views even when the server reports partial progress. */
async function remove(theme, count) {
  if (!confirm(`Radera temat ${niceName(theme)} med ${count} bilder? Det går inte att ångra.`))
    return;
  busy = true;
  let deletionRequested = false;
  try {
    deletionRequested = true;
    const response = await fetch("/api/themes/delete", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ theme, confirm: theme }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Serverfel ${response.status}`);
    toast(`Temat ${niceName(theme)} är raderat.`);
  } catch (err) {
    toast(err.message);
  } finally {
    // A failed response may still mean that the server deleted a bounded batch.
    if (deletionRequested) window.dispatchEvent(new Event("attic:zip-updated"));
    busy = false;
  }
}

/** Open the selected theme in the configured launcher workflow. */
function useInLauncher(theme) {
  const select = $("d-name");
  if ([...select.options].some((x) => x.value === theme)) {
    select.value = theme;
    select.dispatchEvent(new Event("change"));
  }
  $("d-theme").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Render one theme card and its available image counts. */
function card(theme, items) {
  const el = document.createElement("article");
  el.className = "theme-card";
  const thumbs = document.createElement("div");
  thumbs.className = "theme-thumbs";
  const apps = [...new Set(items.map((x) => x.app))].sort((a, b) => a.localeCompare(b, "sv"));
  for (const app of apps.slice(0, 6)) {
    const pick =
      items.find((x) => x.app === app && !x.variant && x.dimensions === "512x512") ||
      items.find((x) => x.app === app);
    const img = document.createElement("img");
    img.src = pick.url;
    img.alt = "";
    img.loading = "lazy";
    thumbs.append(img);
  }
  const title = document.createElement("h3");
  title.textContent = niceName(theme);
  const meta = document.createElement("p");
  const sizes = SIZES.filter((s) => items.some((x) => x.dimensions === s));
  meta.textContent = `${apps.length} appar · ${items.length} bilder · ${sizes.map((s) => s.split("x")[0]).join(" + ")} px`;
  const picks = document.createElement("div");
  picks.className = "theme-sizes";
  const boxes = sizes.map((size) => {
    const label = document.createElement("label");
    label.className = "r2-check-chip";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.value = size;
    label.append(box, document.createTextNode(size.replace("x", " × ")));
    picks.append(label);
    return box;
  });
  const actions = document.createElement("div");
  actions.className = "theme-actions";
  const zip = button("Ladda ner ZIP", "secondary-button", () => {
    if (!busy)
      download(
        theme,
        boxes.filter((b) => b.checked).map((b) => b.value),
        zip,
      );
  });
  actions.append(
    button("Visa bilder", "secondary-button", () =>
      window.dispatchEvent(new CustomEvent("attic:show-images", { detail: { theme } })),
    ),
    button("Använd i App Launcher", "primary-button", () => useInLauncher(theme)),
    zip,
    button("Radera tema", "card-action danger", () => {
      if (!busy) remove(theme, items.length);
    }),
  );
  el.append(thumbs, title, meta, picks, actions);
  return el;
}

/** Render the current theme catalogue and selection state. */
function render() {
  const byTheme = new Map();
  for (const image of images) {
    if (!image.theme) continue;
    if (!byTheme.has(image.theme)) byTheme.set(image.theme, []);
    byTheme.get(image.theme).push(image);
  }
  const themes = [...byTheme.keys()].sort((a, b) => a.localeCompare(b, "sv"));
  const grid = $("theme-grid");
  grid.replaceChildren(...themes.map((t) => card(t, byTheme.get(t))));
  if (!themes.length) {
    const p = document.createElement("p");
    p.className = "r2-notice";
    p.textContent = "Inga teman ännu. Ladda upp en ZIP med mappen themes/<tema>/<app>/.";
    grid.append(p);
  }
}

/** Display the theme library and apply an optional initial selection. */
export function showThemes(next) {
  images = next;
  render();
}

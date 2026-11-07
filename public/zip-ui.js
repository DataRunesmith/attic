import { fillMissingThemes, readImageZip, validateMediesviten } from "./zip-import.js";
const $ = (id) => document.getElementById(id);
const state = {
  items: [],
  skipped: [],
  running: false,
  cancel: false,
  controller: null,
  requiresFullTheme: false,
};
const slug = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const node = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
function error(text) {
  $("zip-error").textContent = text;
  $("zip-error").classList.toggle("hidden", !text);
}
function open() {
  if (state.running) return;
  state.items = [];
  state.skipped = [];
  $("zip-file").value = "";
  $("zip-results").classList.add("hidden");
  error("");
  $("zip-dialog").showModal();
}
function close() {
  if (state.running) {
    state.cancel = true;
    state.controller?.abort();
    $("zip-summary").textContent = "Avbryter efter pågående fil…";
    return;
  }
  $("zip-dialog").close();
}
function field(labelName, value, placeholder, change, disabled = false) {
  const l = node("label");
  l.textContent = labelName;
  const inp = node("input");
  inp.type = "text";
  inp.value = value;
  inp.placeholder = placeholder;
  inp.maxLength = 64;
  inp.disabled = disabled;
  inp.addEventListener("input", () => change(inp.value));
  l.append(inp);
  return l;
}
function valid(item) {
  return (
    !!slug(item.app) &&
    slug(item.app).length <= 48 &&
    (item.category !== "themes" || (!!slug(item.theme) && slug(item.theme).length <= 48))
  );
}
function ready() {
  const active = state.items.filter((x) => x.selected && x.status !== "done");
  return (
    !state.running &&
    active.length > 0 &&
    active.every(valid) &&
    (!state.requiresFullTheme || validateMediesviten(state.items).valid)
  );
}
function draw() {
  $("zip-list").replaceChildren();
  const selected = state.items.filter((x) => x.selected),
    pending = selected.filter((x) => x.status !== "done"),
    done = state.items.filter((x) => x.status === "done");
  const themeCheck = state.requiresFullTheme ? validateMediesviten(state.items) : null;
  $("zip-summary").textContent =
    `${state.items.length} giltiga PNG · ${selected.length} valda · ${done.length} uppladdade` +
    (themeCheck && !themeCheck.valid
      ? ` · Ofullständigt tema: ${themeCheck.missing.slice(0, 5).join(", ")}${themeCheck.missing.length > 5 ? "…" : ""}`
      : "");
  for (const item of state.items) {
    const row = node("div", "zip-item");
    row.dataset.status = item.status;
    const chk = node("input");
    chk.type = "checkbox";
    chk.checked = item.selected;
    chk.disabled = state.running || item.status === "done";
    chk.setAttribute("aria-label", `Ta med ${item.path}`);
    chk.addEventListener("change", () => {
      item.selected = chk.checked;
      draw();
    });
    row.append(chk);
    const name = node("div", "zip-source", item.path);
    name.append(
      node("span", "", `${item.size.replace("x", " × ")} · ${Math.round(item.bytes / 1024)} KB`),
    );
    row.append(name);
    const type = node("label");
    type.textContent = "Kategori";
    const sel = node("select");
    sel.disabled = state.running || item.status === "done";
    for (const [v, text] of [
      ["apps", "Applikation"],
      ["themes", "Tema"],
    ]) {
      const op = node("option", "", text);
      op.value = v;
      op.selected = item.category === v;
      sel.append(op);
    }
    sel.addEventListener("change", () => {
      item.category = sel.value;
      draw();
    });
    type.append(sel);
    row.append(type);
    row.append(
      field(
        "App",
        item.app,
        "Appnamn",
        (v) => {
          item.app = v;
          $("zip-upload").disabled = !ready();
        },
        state.running || item.status === "done",
      ),
    );
    if (item.category === "themes") {
      row.append(
        field(
          "Tema",
          item.theme,
          "Temanamn",
          (v) => {
            item.theme = slug(v);
            $("zip-upload").disabled = !ready();
          },
          state.running || item.status === "done",
        ),
      );
      row.append(
        field(
          "Variant",
          item.variant || "",
          "Valfri variant",
          (v) => {
            item.variant = slug(v);
            $("zip-upload").disabled = !ready();
          },
          state.running || item.status === "done",
        ),
      );
    } else {
      const label = node("label");
      label.textContent = "Tema";
      const fieldInput = node("input");
      fieldInput.value = "–";
      fieldInput.disabled = true;
      label.append(fieldInput);
      row.append(label);
    }
    if (item.status === "done") row.append(node("div", "zip-item-note", "✓ Sparad i Attic"));
    else if (item.status === "error") row.append(node("div", "zip-item-note", item.message));
    else if (item.selected && !valid(item))
      row.append(
        node("div", "zip-item-note", "Ange appnamn och eventuellt tema innan uppladdning."),
      );
    $("zip-list").append(row);
  }
  $("zip-upload").disabled = !ready();
  $("zip-upload").textContent =
    done.length && pending.length
      ? `Försök igen (${pending.length})`
      : `Ladda upp ${pending.length} ${pending.length === 1 ? "bild" : "bilder"}`;
  $("zip-skipped").replaceChildren();
  $("zip-skipped").classList.toggle("hidden", !state.skipped.length);
  if (state.skipped.length) {
    $("zip-skipped").append(node("strong", "", `${state.skipped.length} filer hoppades över:`));
    const ul = node("ul");
    for (const x of state.skipped.slice(0, 40)) {
      ul.append(node("li", "", `${x.path}: ${x.reason}`));
    }
    if (state.skipped.length > 40) ul.append(node("li", "", "…och fler"));
    $("zip-skipped").append(ul);
  }
}
async function chooseFile() {
  if (state.running) return;
  error("");
  $("zip-list").replaceChildren();
  $("zip-results").classList.remove("hidden");
  $("zip-summary").textContent = "Analyserar ZIP-filen lokalt…";
  $("zip-skipped").classList.add("hidden");
  $("zip-upload").disabled = true;
  const file = $("zip-file").files?.[0];
  if (!file) {
    $("zip-results").classList.add("hidden");
    return;
  }
  if (!file.name.toLowerCase().endsWith(".zip")) {
    error("Välj en fil som slutar på .zip.");
    return;
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 40)); // Let loading message paint before unzip.
    // Stream the decompression into a pre-sized output buffer to cap ZIP bombs.
    const decoder = globalThis.pako;
    const inflater = decoder?.Inflate
      ? (compressed, expected) => {
          const unpack = new decoder.Inflate({ raw: true, chunkSize: 65536 });
          const out = new Uint8Array(expected);
          let written = 0;
          unpack.onData = (chunk) => {
            if (written + chunk.length > expected)
              throw Error("ZIP-filen expanderar mer än väntat.");
            out.set(chunk, written);
            written += chunk.length;
          };
          unpack.push(compressed, true);
          if (unpack.err || written !== expected) throw Error("Felaktig ZIP-komprimering.");
          return out;
        }
      : null;
    const result = await readImageZip(file, inflater);
    state.requiresFullTheme = /mediesviten[-_ ]?14/i.test(file.name);
    state.items = fillMissingThemes(result.images, file.name).map((i, id) => ({
      ...i,
      id,
      selected: true,
      status: "ready",
      message: "",
    }));
    state.skipped = result.skipped;
    draw();
  } catch (e) {
    state.items = [];
    state.skipped = [];
    $("zip-summary").textContent = "Kunde inte importera ZIP-filen";
    error(e.message || "Ogiltig ZIP-fil.");
  }
}
async function upload() {
  if (!ready()) return;
  state.running = true;
  state.cancel = false;
  error("");
  $("zip-file").disabled = true;
  $("zip-upload").disabled = true;
  const selected = state.items.filter((x) => x.selected && x.status !== "done");
  let uploaded = 0,
    failed = 0;
  for (const item of selected) {
    if (state.cancel) break;
    $("zip-summary").textContent =
      `Sparar bild ${uploaded + failed + 1} av ${selected.length}… (${item.path})`;
    const form = new FormData();
    form.set("file", item.file, item.file.name);
    form.set("category", item.category);
    form.set("app", item.app.trim());
    form.set("theme", item.category === "themes" ? item.theme.trim() : "");
    form.set("variant", item.category === "themes" ? (item.variant || "").trim() : "");
    const controller = new AbortController();
    state.controller = controller;
    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      let parsed = {};
      try {
        parsed = await response.json();
      } catch {}
      if (!response.ok) throw new Error(parsed.error || `Serverfel ${response.status}`);
      item.status = "done";
      item.message = "";
      uploaded++;
    } catch (e) {
      if (controller.signal.aborted) {
        item.status = "ready";
        break;
      }
      item.status = "error";
      item.message = e.message || "Uppladdningen misslyckades";
      failed++;
    }
    draw();
  }
  state.controller = null;
  state.running = false;
  $("zip-file").disabled = false;
  draw();
  const remaining = state.items.filter((x) => x.selected && x.status !== "done").length;
  $("zip-summary").textContent =
    `${state.items.filter((x) => x.status === "done").length} uppladdade · ${remaining} återstår`;
  if (uploaded) window.dispatchEvent(new Event("attic:zip-updated"));
  if (failed)
    error(`${failed} bilder kunde inte sparas. Kontrollera respektive rad och försök igen.`);
  if (state.cancel)
    error("Importen avbröts. Bilder som redan sparats finns kvar; övriga kan laddas upp senare.");
}
function init() {
  document.querySelectorAll("[data-open-zip]").forEach((b) => b.addEventListener("click", open));
  $("zip-close").addEventListener("click", close);
  $("zip-cancel").addEventListener("click", close);
  $("zip-file").addEventListener("change", chooseFile);
  $("zip-upload").addEventListener("click", upload);
  $("zip-dialog").addEventListener("cancel", (e) => {
    if (state.running) {
      e.preventDefault();
      close();
    }
  });
  $("zip-dialog").addEventListener("click", (e) => {
    if (e.target === $("zip-dialog") && !state.running) close();
  });
}
init();

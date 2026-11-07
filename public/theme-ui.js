const $ = (s) => document.getElementById(s),
  state = { preview: false, rows: [], busy: false };
const msg = (s) => ($("d-status").textContent = s);
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  setTimeout(() => $("toast").classList.remove("visible"), 4000);
}
function clear() {
  state.rows = [];
  state.preview = false;
  $("d-apply").disabled = true;
  $("d-table").replaceChildren();
}
function visible() {
  $("d-theme").hidden = location.hash !== "#teman";
}
window.addEventListener("hashchange", visible);
document
  .querySelectorAll("[data-view]")
  .forEach((x) => x.addEventListener("click", () => queueMicrotask(visible)));
async function themes() {
  try {
    let all = [],
      cursor = null,
      n = 0;
    do {
      const r = await fetch(
        "/api/images" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        { cache: "no-store" },
      );
      if (!r.ok) throw Error("Kan inte läsa bilderna.");
      const d = await r.json();
      all.push(...d.images);
      cursor = d.cursor;
      if (++n > 50) throw Error("För många sidor.");
    } while (cursor);
    const sel = $("d-name"),
      old = sel.value,
      names = [
        ...new Set(all.filter((x) => x.category === "themes" && x.theme).map((x) => x.theme)),
      ].sort();
    sel.replaceChildren(
      new Option("Välj tema…", ""),
      ...names.map((x) => new Option(x.replace(/-/g, " "), x)),
    );
    if (names.includes(old)) sel.value = old;
    msg(names.length + " teman tillgängliga.");
  } catch (e) {
    msg(e.message);
  }
}
async function send(url, data) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || "Serverfel " + r.status);
  return d;
}
function show(rows) {
  const root = $("d-table");
  root.replaceChildren();
  if (!rows.length) {
    root.textContent = "Inga matchande Access-appar.";
    return;
  }
  const t = document.createElement("table"),
    h = t.createTHead().insertRow();
  for (const s of ["App", "Ikon", "Resultat"]) {
    const th = document.createElement("th");
    th.textContent = s;
    h.append(th);
  }
  const b = t.createTBody();
  for (const row of rows) {
    const tr = b.insertRow();
    tr.insertCell().textContent = row.name;
    const td = tr.insertCell();
    if (row.url) {
      const img = document.createElement("img");
      img.src = row.url;
      img.alt = "";
      td.append(img);
    } else td.textContent = "—";
    tr.insertCell().textContent = row.reason || (row.change ? "Kommer uppdateras" : "Redan aktiv");
  }
  root.append(t);
}
for (const key of ["d-name", "d-size"])
  $(key).addEventListener("change", () => {
    clear();
    msg("Förhandsgranska valet.");
  });
$("d-preview").addEventListener("click", async () => {
  if (state.busy) return;
  const theme = $("d-name").value,
    size = $("d-size").value;
  if (!theme) {
    msg("Välj tema först.");
    return;
  }
  clear();
  state.busy = true;
  $("d-preview").disabled = true;
  msg("Kontrollerar ikonmatchningar…");
  try {
    const d = await send("/api/theme/preview", { theme, size });
    state.rows = d.rows;
    state.preview = true;
    show(d.rows);
    const count = d.rows.filter((x) => x.change).length;
    msg(count + " av " + d.rows.length + " appar kan uppdateras.");
    $("d-apply").disabled = !count;
  } catch (e) {
    msg(e.message);
  } finally {
    state.busy = false;
    $("d-preview").disabled = false;
  }
});
$("d-apply").addEventListener("click", async () => {
  if (!state.preview || state.busy) return;
  const changes = state.rows
    .filter((x) => x.change)
    .map((x) => ({ id: x.id, old_url: x.old_url, url: x.url }));
  if (!changes.length) return;
  if (!confirm("Applicera temat på " + changes.length + " appar?")) return;
  state.busy = true;
  $("d-apply").disabled = true;
  $("d-preview").disabled = true;
  msg("Uppdaterar Cloudflare…");
  try {
    const d = await send("/api/theme/apply", {
      theme: $("d-name").value,
      size: $("d-size").value,
      changes,
    });
    const result =
      d.updated +
      " av " +
      changes.length +
      " appar har nu temat i App Launcher." +
      (d.failed.length ? " Fel: " + d.failed.map((x) => x.name + ": " + x.error).join("; ") : "");
    toast(result);
    // Re-read the live icons so the table shows what Cloudflare actually has now.
    const live = await send("/api/theme/preview", {
      theme: $("d-name").value,
      size: $("d-size").value,
    });
    state.rows = live.rows;
    show(live.rows);
    $("d-apply").disabled = !live.rows.some((x) => x.change);
    msg(result);
  } catch (e) {
    msg(e.message);
  } finally {
    state.busy = false;
    $("d-preview").disabled = false;
  }
});
window.addEventListener("attic:zip-updated", themes);
visible();
themes();

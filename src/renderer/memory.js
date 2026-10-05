// ARGUS Memory view (v1.72.0): how full each agent's memory is.
// Three levels, labelled as memtier defines them (not as the first mockup did):
//   L1 = MEMORY.md, loaded on every turn      (cap 4 KB)
//   L2 = INDEX_FULL.md, the full index        (scale 100 KB)
//   L3 = topic files, read on demand          (scale 1 MB)
// Data: main process memory-data.js (reads files other agents write, writes nothing).
// Loaded once on start and when the view opens; no timers.
(() => {
  if (!window.api || !window.api.memoryData) return;
  const L1_CAP = 4096, L2_SCALE = 100 * 1024, L3_SCALE = 1024 * 1024, WARN = 0.75, CRIT = 0.95;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const kb = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : (b / 1024).toFixed(1) + " KB";
  const tk = (n) => n == null ? "-" : Math.round(n / 1000) + "K";
  // Colour is never the only signal: amber adds a triangle, red a filled circle.
  const level = (frac) => frac >= CRIT ? { cls: "crit", mark: "\u25CF" } : frac >= WARN ? { cls: "warn", mark: "\u25B2" } : { cls: "ok", mark: "" };

  let data = null;
  const lookup = (name) => data && data.ok ? data.agents[norm(name)] : null;

  // ---------------------------------------------------------------- sidebar
  const agentList = document.getElementById("agent-list");
  const libNav = document.getElementById("library-nav");
  const nav = el("button", "memory-nav");
  nav.title = "Memory - how full each agent's memory is";
  nav.append(el("span", "memory-nav-title", "MEMORY"), el("span", "memory-nav-sub", "fill levels"));
  nav.addEventListener("click", () => openView());
  agentList.parentNode.insertBefore(nav, libNav || agentList);

  const view = el("div");
  view.id = "memory-view";
  view.className = "hidden";
  document.getElementById("main-panel").appendChild(view);

  function openView() {
    document.body.classList.add("memory-open");
    if (document.body.classList.contains("argus-open")) document.querySelector("#argus-view .argus-close")?.click();
    view.classList.remove("hidden");
    nav.classList.add("active");
    load().then(renderView);
  }
  function closeView() {
    document.body.classList.remove("memory-open");
    view.classList.add("hidden");
    nav.classList.remove("active");
  }
  agentList.addEventListener("click", (e) => { if (e.target.closest(".agent-item")) closeView(); }, true);
  document.querySelector(".argus-nav")?.addEventListener("click", closeView, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("memory-open")) closeView(); });

  // ---------------------------------------------------------------- data
  async function load() {
    try { data = await window.api.memoryData(); } catch (e) { data = { ok: false, error: String(e) }; }
    markRows();
    return data;
  }

  // ---------------------------------------------------------------- bars
  function bar(used, scale, lvl) {
    const b = el("span", "mem-bar" + (lvl ? " " + lvl.cls : ""));
    const f = el("span", "mem-bar-fill");
    f.style.width = Math.min(100, Math.round((used / scale) * 100)) + "%";
    b.appendChild(f);
    return b;
  }

  // ---------------------------------------------------------------- sidebar stripes + hover popover
  let pop = null;
  function hidePop() { if (pop) { pop.remove(); pop = null; } }
  function showPop(item, a) {
    hidePop();
    pop = el("div", "mem-pop");
    const l1 = a.l1 / a.cap, lv = level(l1);
    pop.append(el("div", "mem-pop-title", "Memory"),
      el("div", "mem-pop-row " + lv.cls, "L1 " + kb(a.l1) + " of " + kb(a.cap) + " (" + Math.round(l1 * 100) + "%) " + lv.mark),
      el("div", "mem-pop-row", "L2 " + kb(a.l2)),
      el("div", "mem-pop-row", "L3 " + kb(a.l3) + " in " + a.files + " files"));
    document.body.appendChild(pop);
    const r = item.getBoundingClientRect();
    pop.style.left = (r.right + 6) + "px";
    pop.style.top = Math.max(4, r.top) + "px";
  }
  function markRows() {
    if (!data || !data.ok) return;
    for (const item of agentList.querySelectorAll(".agent-item")) {
      item.querySelector(":scope > .mem-mark")?.remove();
      const a = lookup(item.dataset.folderName);
      if (!a) continue;
      const m = el("span", "mem-mark");
      m.append(bar(a.l1, a.cap, level(a.l1 / a.cap)), bar(a.l2, L2_SCALE), bar(a.l3, L3_SCALE));
      item.appendChild(m);
      if (!item.dataset.memHover) {
        item.dataset.memHover = "1";
        item.addEventListener("mouseenter", () => { const x = lookup(item.dataset.folderName); if (x) showPop(item, x); });
        item.addEventListener("mouseleave", hidePop);
      }
    }
  }
  // The list is rebuilt with innerHTML on every change; re-apply the stripes.
  // childList only (no subtree), so adding a stripe inside a row cannot re-trigger it.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; markRows(); });
  }).observe(agentList, { childList: true });

  // ---------------------------------------------------------------- page
  function renderView() {
    view.textContent = "";
    const head = el("div", "mem-head");
    const t = el("div", "mem-title");
    t.append(el("span", "mem-title-main", "MEMORY"), el("span", "mem-title-sub", "how full each agent's memory is"));
    const close = el("button", "mem-close", "\u00D7");
    close.title = "Back to the agents (Esc)";
    close.addEventListener("click", closeView);
    head.append(t, close);
    const body = el("div", "mem-body");
    view.append(head, body);
    if (!data || !data.ok) { body.appendChild(el("div", "mem-empty", "Memory figures are not available (" + ((data && data.error) || "no data") + ").")); return; }

    const legend = el("div", "mem-legend");
    legend.append(
      el("span", null, "L1 MEMORY.md, loaded every turn (cap 4 KB)"),
      el("span", null, "L2 INDEX_FULL.md (scale 100 KB)"),
      el("span", null, "L3 topic files, read on demand (scale 1 MB)"),
      el("span", null, "Green under 75%, amber \u25B2 75-95%, red \u25CF 95% or more of the L1 cap"));
    body.appendChild(legend);
    body.appendChild(el("div", "mem-stamp", "Memory figures " + (data.generated || "?").replace("T", " ") + " | startup tokens " + (data.baselineAt || "?").slice(0, 10)));

    const rows = [];
    for (const item of agentList.querySelectorAll(".agent-item")) {
      const a = lookup(item.dataset.folderName);
      if (a) rows.push({ name: item.querySelector(".agent-item-name")?.firstChild?.textContent || item.dataset.folderName, a });
    }
    rows.sort((x, y) => (y.a.l1 / y.a.cap) - (x.a.l1 / x.a.cap));
    const table = el("div", "mem-table");
    const hdr = el("div", "mem-row mem-row-head");
    ["Agent", "L1 (4 KB cap)", "L2", "L3", "Startup tokens", ""].forEach((h) => hdr.appendChild(el("span", null, h)));
    table.appendChild(hdr);
    for (const { name, a } of rows) {
      const lv = level(a.l1 / a.cap);
      const r = el("div", "mem-row");
      r.appendChild(el("span", "mem-name", name));
      const c1 = el("span", "mem-cell " + lv.cls);
      c1.append(bar(a.l1, a.cap, lv), el("span", "mem-num", kb(a.l1) + " (" + Math.round((a.l1 / a.cap) * 100) + "%) " + lv.mark));
      const c2 = el("span", "mem-cell");
      c2.append(bar(a.l2, L2_SCALE), el("span", "mem-num", kb(a.l2)));
      const c3 = el("span", "mem-cell");
      c3.append(bar(a.l3, L3_SCALE), el("span", "mem-num", kb(a.l3) + " / " + a.files + " files"));
      const c4 = el("span", "mem-num", tk(a.tokens) + (a.prevTokens != null ? " (was " + tk(a.prevTokens) + ")" : " (no earlier figure)"));
      const open = el("button", "mem-open", "Open folder");
      open.addEventListener("click", () => window.api.memoryOpenFolder(a.key));
      r.append(c1, c2, c3, c4, open);
      table.appendChild(r);
    }
    body.appendChild(table);
  }

  load();
})();

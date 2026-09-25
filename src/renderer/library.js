// The Library (v1.38.0): Projects / Documents / Images from the shared
// workspace registry, one place for everything the agents have made. Data and
// opening live in main.js + registry.js; this file only draws.
//
// Built outside renderer.js on purpose, the same way header-tasks.js is: it
// adds its own nav and view and touches nothing existing, so a fault here
// cannot break chat, and removing it is one <script> and one <link>.
//
// Every string shown comes from registry entries other agents wrote, so it
// all goes in via textContent - never innerHTML.

(() => {
  "use strict";

  const TABS = [
    { type: "project", label: "Projects", empty: "No projects registered yet." },
    { type: "document", label: "Documents", short: "Docs", empty: "No documents registered yet." },
    { type: "image", label: "Images", empty: "No images registered yet." },
  ];
  const POLL_MS = 30000;

  let entries = [];
  let tab = "project";
  let query = "";
  let agentFilter = "";
  let showArchived = false;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // --- sidebar nav ----------------------------------------------------------
  const nav = el("div");
  nav.id = "library-nav";
  const navTitle = el("div", "library-nav-title", "Library");
  nav.appendChild(navTitle);
  const navRow = el("div", "library-nav-row");
  const navBtns = new Map();
  TABS.forEach((t) => {
    const b = el("button", "library-nav-btn");
    b.appendChild(el("span", "library-nav-label", t.short || t.label));
    b.appendChild(el("span", "library-nav-count", "0"));
    b.addEventListener("click", () => openLibrary(t.type));
    navBtns.set(t.type, b);
    navRow.appendChild(b);
  });
  nav.appendChild(navRow);
  const agentList = document.getElementById("agent-list");
  agentList.parentNode.insertBefore(nav, agentList);

  // Packaged-install feature probe (v1.59.0): a clean install has no
  // shared_registry for the Library to show, so hide it entirely rather than
  // opening onto three empty tabs. Always true today for Iddo's own
  // workspace, so this never hides anything for him.
  window.api.getFeatures().then((f) => {
    if (f && f.library === false) nav.classList.add("hidden");
  }).catch(() => {});

  // --- the view -------------------------------------------------------------
  const view = el("div");
  view.id = "library-view";
  view.className = "hidden";

  const head = el("div", "library-head");
  const tabs = el("div", "library-tabs");
  const tabBtns = new Map();
  TABS.forEach((t) => {
    const b = el("button", "library-tab", t.label);
    b.addEventListener("click", () => { tab = t.type; render(); });
    tabBtns.set(t.type, b);
    tabs.appendChild(b);
  });
  head.appendChild(tabs);

  const search = el("input", "library-search");
  search.type = "search";
  search.placeholder = "Search title, description, topic…";
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); render(); });
  head.appendChild(search);

  const agentSel = el("select", "library-agent");
  agentSel.addEventListener("change", () => { agentFilter = agentSel.value; render(); });
  head.appendChild(agentSel);

  const archLabel = el("label", "library-arch");
  const arch = el("input");
  arch.type = "checkbox";
  arch.addEventListener("change", () => { showArchived = arch.checked; render(); });
  archLabel.appendChild(arch);
  archLabel.append(" Archived");
  head.appendChild(archLabel);

  const close = el("button", "library-close", "×");
  close.title = "Back to the agent";
  close.addEventListener("click", closeLibrary);
  head.appendChild(close);

  const status = el("div", "library-status");
  const body = el("div", "library-body");
  view.appendChild(head);
  view.appendChild(status);
  view.appendChild(body);
  document.getElementById("main-panel").appendChild(view);

  function openLibrary(type) {
    tab = type;
    document.body.classList.add("library-open");
    view.classList.remove("hidden");
    render();
    refresh();
  }

  function closeLibrary() {
    if (viewing) closeViewer();
    document.body.classList.remove("library-open");
    view.classList.add("hidden");
    navBtns.forEach((b) => b.classList.remove("active"));
  }

  // Picking an agent always means "back to chat". Capture phase, so this runs
  // before renderer.js's own handler and needs nothing from it.
  agentList.addEventListener("click", (e) => {
    if (e.target.closest(".agent-item")) closeLibrary();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("library-open")) { if (viewing) closeViewer(); else closeLibrary(); }
  });

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function linkLabel(e) {
    if (!e.link) return "no link";
    if (e.isUrl) {
      try { return new URL(e.link).host; } catch (err) { return e.link; }
    }
    return e.link.split(/[\\/]/).pop();
  }

  function flash(msg) {
    status.textContent = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { status.textContent = ""; }, 4000);
  }

  async function act(e, action) {
    // Documents and images open INSIDE the app when they can (v1.39.0, Iddo:
    // "viewable inside the Agent Desktop main screen ... just make a back
    // button"). Web links, and anything not viewable, still go outside.
    if (action === "open" && e.viewable && !e.isUrl) return openViewer(e);
    const r = await window.api.registryAction(e.id, action).catch((err) => ({ ok: false, error: String(err) }));
    if (!r.ok) flash(r.error || "Could not do that.");
    else if (action === "copy") flash("Link copied.");
  }

  // --- in-app viewer --------------------------------------------------------
  const viewer = el("div", "library-viewer hidden");
  const vbar = el("div", "library-viewer-bar");
  const vback = el("button", "library-btn library-back", "← Back");
  const vtitle = el("div", "library-viewer-title");
  const vext = el("button", "library-btn", "Open outside the app");
  const vfolder = el("button", "library-btn", "Show in folder");
  vbar.append(vback, vtitle, vext, vfolder);
  const vframe = el("iframe", "library-viewer-frame");
  viewer.append(vbar, vframe);
  view.appendChild(viewer);
  let viewing = null;

  async function openViewer(e) {
    const r = await window.api.registryAction(e.id, "view").catch((err) => ({ ok: false, error: String(err) }));
    if (!r.ok) { flash(r.error || "Could not open it here."); return; }
    viewing = e;
    vtitle.textContent = e.title;
    vframe.src = r.url;
    view.classList.add("viewing");
    viewer.classList.remove("hidden");
  }
  function closeViewer() {
    viewing = null;
    vframe.src = "about:blank";
    view.classList.remove("viewing");
    viewer.classList.add("hidden");
  }
  vback.addEventListener("click", closeViewer);
  vext.addEventListener("click", () => viewing && window.api.registryAction(viewing.id, viewing.isUrl ? "openPdf" : "open"));
  vfolder.addEventListener("click", () => viewing && window.api.registryAction(viewing.id, "reveal"));

  function card(e) {
    const c = el("div", "library-card" + (e.type === "image" ? " library-card-image" : ""));
    if (e.type === "image") {
      const frame = el("div", "library-thumb");
      if (e.thumbnail) {
        const img = el("img");
        img.loading = "lazy";
        img.alt = e.title;
        img.src = "file:///" + e.thumbnail.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
        frame.appendChild(img);
      } else {
        frame.appendChild(el("span", "library-thumb-missing", "no preview"));
      }
      frame.addEventListener("click", () => act(e, "open"));
      c.appendChild(frame);
    }
    const main = el("div", "library-card-main");
    const titleRow = el("div", "library-card-title-row");
    const title = el("button", "library-card-title", e.title);
    title.title = e.link;
    title.addEventListener("click", () => act(e, "open"));
    titleRow.appendChild(title);
    if (e.status !== "active") titleRow.appendChild(el("span", "library-tag", e.status));
    if (e.missing) titleRow.appendChild(el("span", "library-tag library-tag-bad", "file missing"));
    if (e.stale) titleRow.appendChild(el("span", "library-tag", `unconfirmed ${e.staleDays} days`));
    main.appendChild(titleRow);
    if (e.description) main.appendChild(el("div", "library-card-desc", e.description));
    const meta = el("div", "library-card-meta");
    [e.agent, e.topic, fmtDate(e.updatedAt), linkLabel(e)].filter(Boolean).forEach((m, i) => {
      if (i) meta.appendChild(el("span", "library-dot", "·"));
      meta.appendChild(el("span", null, m));
    });
    main.appendChild(meta);
    const actions = el("div", "library-card-actions");
    // v1.59.4: a phone app package is installed on the phone, not opened here;
    // the click shows main's explanation instead of silently doing nothing.
    const phonePkg = !e.isUrl && /\.(apk|aab|ipa)$/i.test(e.link || "");
    const open = el("button", "library-btn library-btn-primary", e.isUrl ? "Open link" : phonePkg ? "Install on phone" : "Open");
    open.addEventListener("click", () => act(e, "open"));
    actions.appendChild(open);
    // A web page that also has a PDF copy: the link opens in the browser, the
    // PDF inside the app.
    if (e.isUrl && e.viewable) {
      const pdfBtn = el("button", "library-btn", "View PDF");
      pdfBtn.addEventListener("click", () => openViewer(e));
      actions.appendChild(pdfBtn);
    }
    if (!e.isUrl && e.link) {
      const rev = el("button", "library-btn", "Show in folder");
      rev.addEventListener("click", () => act(e, "reveal"));
      actions.appendChild(rev);
    }
    const copy = el("button", "library-btn", "Copy link");
    copy.addEventListener("click", () => act(e, "copy"));
    actions.appendChild(copy);
    main.appendChild(actions);
    c.appendChild(main);
    return c;
  }

  function visible(type) {
    return entries.filter((e) => e.type === type && (showArchived || e.status === "active"));
  }

  function updateCounts() {
    TABS.forEach((t) => {
      const b = navBtns.get(t.type);
      b.querySelector(".library-nav-count").textContent = String(visible(t.type).length);
    });
  }

  function render() {
    updateCounts();
    const libOpen = document.body.classList.contains("library-open");
    navBtns.forEach((b, type) => b.classList.toggle("active", libOpen && type === tab));
    tabBtns.forEach((b, type) => {
      b.classList.toggle("active", type === tab);
      b.textContent = `${TABS.find((t) => t.type === type).label} (${visible(type).length})`;
    });

    // Agent filter lists only agents that actually have entries.
    const agents = [...new Set(entries.map((e) => e.agent).filter(Boolean))].sort();
    const keep = agentFilter;
    agentSel.textContent = "";
    agentSel.appendChild(new Option("All agents", ""));
    agents.forEach((a) => agentSel.appendChild(new Option(a, a)));
    agentSel.value = agents.includes(keep) ? keep : "";
    agentFilter = agentSel.value;

    body.textContent = "";
    body.className = "library-body" + (tab === "image" ? " library-grid" : "");
    const rows = visible(tab).filter((e) =>
      (!agentFilter || e.agent === agentFilter) &&
      (!query || [e.title, e.description, e.topic, e.agent].join(" ").toLowerCase().includes(query)));
    if (!rows.length) {
      const t = TABS.find((x) => x.type === tab);
      body.appendChild(el("p", "library-empty", query || agentFilter ? "Nothing matches." : t.empty));
      return;
    }
    rows.forEach((e) => body.appendChild(card(e)));
  }

  async function refresh() {
    try {
      entries = await window.api.registryList();
    } catch (e) {
      console.error("[library] registry", e);
      return;
    }
    // Do not rebuild under the user's cursor while the view is closed - the
    // counts are all that is visible then.
    if (document.body.classList.contains("library-open")) render();
    else updateCounts();
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();

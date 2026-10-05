// Agent documents side panel (renderer). Self-contained: builds its own header button and panel.
// Wiring still needed in renderer.js (see PENDING_EDITS.md): call window.agentDocsPanel.setAgent(agentPath)
// whenever the visible agent changes (null when none). Talks only to window.api.agentDocs* (ids, never paths).
(function () {
  const PAGE = 40;
  const TYPES = [["docs", "Documents"], ["image", "Images"], ["all", "All"], ["pdf", "PDF"], ["word", "Word"], ["sheet", "Sheets"], ["video", "Video"], ["other", "Other"]];
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  let agentPath = null;
  let headIcon = null, headName = null, agentInfo = {};
  let btn = null, badge = null, panel = null, listEl = null, countsEl = null, searchEl = null, statusEl = null, viewer = null;
  const state = new Map(); // agentPath -> { open, type, search, view, items, offset, total, sel }
  let reqSeq = 0, searchTimer = null;

  const st = () => {
    if (!state.has(agentPath)) state.set(agentPath, { open: false, type: "docs", search: "", view: null, items: [], offset: 0, total: 0, sel: 0, expanded: {} });
    return state.get(agentPath);
  };

  function build() {
    const header = document.getElementById("chat-header");
    const chatView = document.getElementById("chat-view");
    const body = document.getElementById("chat-body");
    if (!header || !chatView || !body || panel) return;
    btn = el("button", "agent-docs-btn", "Documents");
    btn.id = "agent-docs-btn";
    btn.title = "Finished documents this agent produced (Ctrl+D)";
    badge = el("span", "agent-docs-badge hidden", "");
    btn.appendChild(badge);
    btn.addEventListener("click", toggle);
    const hist = document.getElementById("history-toggle-btn");
    header.insertBefore(btn, hist ? hist.nextSibling : null);

    panel = el("aside", "agent-docs-panel hidden");
    panel.id = "agent-docs-panel";
    const head = el("div", "agent-docs-head");
    const title = el("div", "agent-docs-title");
    headIcon = el("span", "agent-docs-agent-icon");
    headName = el("span", "agent-docs-agent-name");
    title.append(headIcon, headName);
    head.appendChild(title);
    const refresh = el("button", "agent-docs-iconbtn", "Refresh");
    refresh.addEventListener("click", () => load(true, true));
    const viewBtn = el("button", "agent-docs-iconbtn", "List/Grid");
    viewBtn.addEventListener("click", () => { const s = st(); s.view = s.view === "grid" ? "list" : "grid"; render(); });
    const close = el("button", "agent-docs-iconbtn", "Close");
    close.addEventListener("click", toggle);
    head.append(refresh, viewBtn, close);
    searchEl = el("input", "agent-docs-search");
    searchEl.type = "search";
    searchEl.placeholder = "Search documents";
    searchEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st().search = searchEl.value; load(true); }, 200);
    });
    countsEl = el("div", "agent-docs-pills");
    statusEl = el("div", "agent-docs-status");
    listEl = el("div", "agent-docs-list");
    listEl.tabIndex = 0;
    listEl.addEventListener("keydown", onKey);
    panel.append(head, searchEl, countsEl, statusEl, listEl);
    body.parentNode.insertBefore(panel, body.nextSibling);
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d" && agentPath) { e.preventDefault(); toggle(); }
    });
  }

  function toggle() {
    if (!agentPath) return;
    const s = st();
    s.open = !s.open;
    apply();
    if (s.open) load(!s.items.length);
  }

  function apply() {
    if (!panel) return;
    const s = agentPath ? st() : null;
    const open = !!(s && s.open);
    panel.classList.toggle("hidden", !open);
    const cv = document.getElementById("chat-view");
    if (cv) cv.classList.toggle("agent-docs-open", open);
    if (btn) btn.classList.toggle("active", open);
    if (open && searchEl) searchEl.value = s.search;
    if (open) paintHead();
    if (open) render();
  }

  function paintHead() {
    if (!headName) return;
    headName.textContent = (agentInfo.name || "Agent") + " - documents";
    headIcon.textContent = "";
    if (agentInfo.avatar) {
      const img = el("img");
      img.src = agentInfo.avatar;
      img.alt = "";
      headIcon.appendChild(img);
    } else {
      headIcon.textContent = (agentInfo.name || "?").slice(0, 1).toUpperCase();
    }
  }

  async function refreshBadge() {
    if (!btn || !agentPath || !window.api.agentDocsSummary) return;
    const mine = agentPath;
    try {
      const r = await window.api.agentDocsSummary(mine);
      if (mine !== agentPath) return;
      btn.title = r.total + " documents" + (r.unread ? ", " + r.unread + " unread" : "") + " (Ctrl+D)";
      badge.textContent = r.unread ? String(r.unread) : "";
      badge.classList.toggle("hidden", !r.unread);
    } catch (e) { /* badge is optional */ }
  }

  async function load(reset, refresh) {
    const s = st();
    const mine = agentPath, seq = ++reqSeq;
    if (reset) { s.offset = 0; s.items = []; }
    statusEl.textContent = "Loading...";
    let r;
    try {
      r = await window.api.agentDocsList(mine, { type: s.type, search: s.search, offset: s.offset, refresh: !!refresh, stack: true });
    } catch (e) {
      statusEl.textContent = "Could not load documents.";
      return;
    }
    if (seq !== reqSeq || mine !== agentPath) return; // a newer request or another agent won
    s.items = s.items.concat(r.items);
    s.offset = s.items.length;
    s.total = r.total;
    s.counts = r.counts;
    if (!s.view) s.view = "list";
    render();
    refreshBadge();
  }

  function render() {
    if (!panel || !agentPath) return;
    const s = st();
    countsEl.textContent = "";
    for (const [key, label] of TYPES) {
      const n = s.counts ? s.counts[key] || 0 : 0;
      if (key !== "all" && key !== "docs" && key !== "image" && !n && s.type !== key) continue;
      const b = el("button", "agent-docs-pill" + (s.type === key ? " active" : ""), label + " " + n);
      b.addEventListener("click", () => { s.type = key; load(true); });
      countsEl.appendChild(b);
    }
    statusEl.textContent = s.total ? "" : "No documents found.";
    listEl.textContent = "";
    listEl.classList.toggle("grid", s.view === "grid");
    let lastGroup = null;
    s.items.forEach((it, i) => {
      if (it.group !== lastGroup) { lastGroup = it.group; listEl.appendChild(el("div", "agent-docs-group", it.group)); }
      listEl.appendChild(row(it, i, s));
      if (it.older && it.older.length && s.expanded[it.id]) {
        for (const o of it.older) { const orow = row(o, -1, s); orow.classList.add("older"); listEl.appendChild(orow); }
      }
    });
    if (s.items.length < s.total) {
      const more = el("button", "agent-docs-more", "Show more (" + (s.total - s.items.length) + " left)");
      more.addEventListener("click", () => load(false));
      listEl.appendChild(more);
    }
  }

  function row(it, i, s) {
    const r = el("div", "agent-docs-row" + (it.unread ? " unread" : "") + (i === s.sel ? " sel" : ""));
    r.dataset.index = String(i);
    const thumb = el("div", "agent-docs-thumb", it.ext.toUpperCase());
    if (["image", "pdf", "video", "word"].includes(it.type) && window.api.agentDocsThumb) {
      // Lazy: only when the row scrolls into view.
      lazy(thumb, async () => {
        try {
          const t = await window.api.agentDocsThumb(agentPath, it.id);
          if (t && t.ok) {
            const img = el("img");
            img.src = "file:///" + t.path.replace(/\\/g, "/");
            img.alt = "";
            thumb.textContent = "";
            thumb.appendChild(img);
          }
        } catch (e) { /* keep the extension label */ }
      });
    }
    const meta = el("div", "agent-docs-meta");
    meta.appendChild(el("div", "agent-docs-name", it.title));
    meta.appendChild(el("div", "agent-docs-sub", fmtDate(it.mtimeMs) + " - " + fmtSize(it.size) + (it.status ? " - " + it.status : "")));
    const acts = el("div", "agent-docs-actions");
    const mk = (label, fn, title) => { const b = el("button", "agent-docs-act", label); if (title) b.title = title; b.addEventListener("click", (e) => { e.stopPropagation(); fn(it); }); return b; };
    if (it.viewable) acts.appendChild(mk("Open here", openHere));
    acts.appendChild(mk("Open", (x) => openExt(x, "open"), "Open with the default program"));
    acts.appendChild(mk("Folder", (x) => openExt(x, "reveal"), "Show in folder"));
    if (it.unread) acts.appendChild(mk("Mark read", markRead));
    acts.appendChild(mk("Comment", comment, "Send a comment about this document to an agent"));
    if (it.versions > 1) {
      const open = !!s.expanded[it.id];
      const fold = el("button", "agent-docs-fold", it.versions + " versions " + (open ? "(hide older)" : "(show older)"));
      fold.addEventListener("click", (e) => { e.stopPropagation(); s.expanded[it.id] = !open; render(); });
      meta.appendChild(fold);
    }
    r.append(thumb, meta, acts);
    r.addEventListener("click", () => { if (i >= 0) s.sel = i; if (it.viewable) openHere(it); else openExt(it, "open"); });
    return r;
  }

  let io = null;
  function lazy(node, fn) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    if (!io) {
      io = new IntersectionObserver((ents) => ents.forEach((e) => {
        if (e.isIntersecting) { io.unobserve(e.target); const f = e.target._lazy; e.target._lazy = null; if (f) f(); }
      }), { root: null, rootMargin: "120px" });
    }
    node._lazy = fn;
    io.observe(node);
  }

  async function markRead(it) {
    try { await window.api.libraryStateOp({ op: "read", id: it.id, value: true }); } catch (e) { return; }
    it.unread = false;
    render();
    refreshBadge();
  }

  async function openExt(it, how) {
    const r = await window.api.agentDocsOpen(agentPath, it.id, how);
    if (!r.ok) statusEl.textContent = r.error || "Could not open.";
    else if (how === "open" && it.unread) markRead(it);
  }

  async function openHere(it) {
    const r = await window.api.agentDocsOpen(agentPath, it.id, "view");
    if (!r.ok) { statusEl.textContent = r.error || "Could not open."; return; }
    closeViewer();
    viewer = el("div", "agent-docs-viewer");
    const bar = el("div", "agent-docs-viewer-bar");
    bar.appendChild(el("div", "agent-docs-viewer-title", r.title));
    const x = el("button", "agent-docs-iconbtn", "Close");
    x.addEventListener("click", closeViewer);
    bar.appendChild(x);
    let content;
    if (r.type === "image") { content = el("img", "agent-docs-viewer-img"); content.src = r.url; }
    else if (r.type === "video") { content = el("video", "agent-docs-viewer-img"); content.src = r.url; content.controls = true; }
    else { content = el("iframe", "agent-docs-viewer-frame"); content.src = r.url; }
    viewer.append(bar, content);
    panel.parentNode.appendChild(viewer);
    if (it.unread) markRead(it);
  }
  function closeViewer() { if (viewer) { viewer.remove(); viewer = null; } }

  // Reuses the Library's send path (renderer.js window.libraryBridge.send); recipient = this agent by default.
  async function comment(it) {
    const bridge = window.libraryBridge;
    if (!bridge) { statusEl.textContent = "Sending is not available yet."; return; }
    let box = panel.querySelector(".agent-docs-comment");
    if (box) box.remove();
    box = el("div", "agent-docs-comment");
    box.appendChild(el("div", "agent-docs-sub", "Comment on: " + it.title));
    const ta = el("textarea");
    ta.rows = 3;
    ta.placeholder = "Your comment (sent to this agent, with the file path)";
    const send = el("button", "agent-docs-act", "Send");
    const cancel = el("button", "agent-docs-act", "Cancel");
    cancel.addEventListener("click", () => box.remove());
    send.addEventListener("click", async () => {
      if (!ta.value.trim()) return;
      const path = (await window.api.agentDocsOpen(agentPath, it.id, "view")).path || it.name;
      const r = await bridge.send(agentPath, "Comment on \"" + it.title + "\" (" + path + "):\n" + ta.value.trim());
      statusEl.textContent = r.ok ? (r.how === "queued" ? "Queued." : "Sent.") : r.error;
      if (r.ok) box.remove();
    });
    box.append(ta, send, cancel);
    panel.insertBefore(box, listEl);
    ta.focus();
  }

  function onKey(e) {
    const s = st();
    if (!s.items.length) return;
    const it = s.items[s.sel];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      s.sel = Math.max(0, Math.min(s.items.length - 1, s.sel + (e.key === "ArrowDown" ? 1 : -1)));
      render();
      const n = listEl.querySelector(".agent-docs-row.sel");
      if (n) n.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey || !it.viewable) openExt(it, "open"); else openHere(it);
    } else if (e.key.toLowerCase() === "u" && it.unread) markRead(it);
    else if (e.key.toLowerCase() === "c") { e.preventDefault(); comment(it); }
    else if (e.key === "Escape") { if (viewer) closeViewer(); }
  }

  window.agentDocsPanel = {
    setAgent(p, info) {
      build();
      agentPath = p || null;
      agentInfo = info || {};
      paintHead();
      if (btn) btn.classList.toggle("hidden", !agentPath);
      closeViewer();
      apply();
      if (agentPath) { refreshBadge(); if (st().open) load(!st().items.length); }
    },
  };
})();

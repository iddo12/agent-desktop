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
  // v1.60.0: the Projects tab is a pipeline. Ideas and Researched can be projects
  // OR the research papers behind them; Active is real projects only.
  const STAGES = [
    { stage: "idea", label: "Ideas", empty: "No ideas parked right now." },
    { stage: "researched", label: "Researched", empty: "Nothing researched and waiting." },
    { stage: "active", label: "Active", empty: "No active projects." },
  ];
  const IDLE_DAYS = 14; // an idea or researched item nobody has touched for this long is flagged
  let stage = "active";

  let entries = [];
  let tab = "project";
  let query = "";
  let agentFilter = "";
  let showArchived = false;
  // v1.64.0: per-user read state + send history (main keeps it in userData/library-state.json), a
  // filter on the Documents tab, and the comment/send panel in the viewer.
  let libState = { read: {}, history: {} };
  let readFilter = "all"; // all | unread | read
  const isRead = (id) => !!libState.read[id];
  const sentList = (id) => (Array.isArray(libState.history[id]) ? libState.history[id] : []);

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
    if (t.type === "document") {
      // red pill: how many documents are still unread; clicking it opens Documents filtered to those
      const u = el("span", "library-nav-unread hidden", "0");
      u.setAttribute("role", "button");
      u.title = "Unread documents - click to show only those";
      u.addEventListener("click", (ev) => { ev.stopPropagation(); readFilter = "unread"; openLibrary("document"); });
      b.appendChild(u);
    }
    b.addEventListener("click", () => openLibrary(t.type));
    navBtns.set(t.type, b);
    navRow.appendChild(b);
  });
  nav.appendChild(navRow);
  const agentList = document.getElementById("agent-list");
  agentList.parentNode.insertBefore(nav, agentList);

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

  // Documents tab only: the always-visible legend, doubling as the filter (every count is a button).
  const docBar = el("div", "library-docbar hidden");
  const docFilterBtns = new Map();
  [["all", "All", ""], ["unread", "Unread", "is-unread"], ["read", "Read", "is-read"]].forEach(([key, label, cls]) => {
    const b = el("button", "library-docfilter");
    if (cls) b.appendChild(el("span", "library-read-dot " + cls));
    b.appendChild(el("span", "library-docfilter-text", label));
    b.addEventListener("click", () => { readFilter = key; render(); });
    docFilterBtns.set(key, b);
    docBar.appendChild(b);
  });
  docBar.appendChild(el("span", "library-doclegend", "Solid red dot = unread, green ring with a check = read. Opening a document here marks it read; the dot on a card toggles it."));
  const status = el("div", "library-status");
  const body = el("div", "library-body");
  // Stage buttons sit at the bottom of the Projects tab (Iddo's layout choice).
  const stageBar = el("div", "library-stagebar");
  const stageBtns = new Map();
  STAGES.forEach((s) => {
    const b = el("button", "library-stage");
    b.addEventListener("click", () => { stage = s.stage; render(); });
    stageBtns.set(s.stage, b);
    stageBar.appendChild(b);
  });
  view.appendChild(head);
  view.appendChild(docBar);
  view.appendChild(status);
  view.appendChild(body);
  view.appendChild(stageBar);
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

  function fmtSize(bytes) {
    if (typeof bytes !== "number") return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const vread = el("button", "library-btn library-vread");
  const vsend = el("button", "library-btn library-btn-primary", "Comment / send");
  // One-line legend in viewer mode: still clickable, returns to the list filtered that way.
  const vcount = el("span", "library-vcount");
  const vcU = el("button", "library-docfilter");
  const vcR = el("button", "library-docfilter");
  vcU.append(el("span", "library-read-dot is-unread"), el("span", "library-docfilter-text", "Unread"));
  vcR.append(el("span", "library-read-dot is-read"), el("span", "library-docfilter-text", "Read"));
  vcU.title = "Back to the list, unread only";
  vcR.title = "Back to the list, read only";
  vcU.addEventListener("click", () => { readFilter = "unread"; closeViewer(); });
  vcR.addEventListener("click", () => { readFilter = "read"; closeViewer(); });
  vcount.append(vcU, vcR);
  vbar.append(vback, vtitle, vcount, vread, vsend, vext, vfolder);
  const vframe = el("iframe", "library-viewer-frame");
  const vbody = el("div", "library-viewer-body");
  const panel = el("div", "library-send-panel hidden");
  vbody.append(vframe, panel);
  viewer.append(vbar, vbody);
  view.appendChild(viewer);
  let viewing = null;

  async function openViewer(e, opts) {
    const r = await window.api.registryAction(e.id, "view").catch((err) => ({ ok: false, error: String(err) }));
    // "Comment / send" on a document that cannot show inside the app still opens the panel (no preview).
    const panelOnly = !r.ok && opts && opts.panel;
    if (!r.ok && !panelOnly) { flash(r.error || "Could not open it here."); return; }
    stopRec();
    viewing = e;
    vtitle.textContent = e.title;
    // Opening it in the viewer is reading it (Iddo's rule); he can still mark it unread by hand.
    if (e.type === "document" && !isRead(e.id) && !panelOnly) setRead(e, true);
    paintViewerBar();
    panel.classList.toggle("hidden", !(opts && opts.panel));
    if (opts && opts.panel) buildPanel(e);
    if (panelOnly) {
      view.classList.add("viewing");
      viewer.classList.remove("hidden");
      vframe.src = "about:blank";
      return;
    }
    // 2026-10-02: reveal the viewer BEFORE loading the file. A PDF started inside a display:none
    // iframe gets a 0x0 plugin surface and shows grey/blank until something forces a resize
    // (Iddo: "PDF opens grey then fixes itself").
    view.classList.add("viewing");
    viewer.classList.remove("hidden");
    // Iddo (2026-10-02): PDFs opened at 61%; ask Chromium's viewer for 100% via the standard open parameter.
    const target = /\.pdf($|[?#])/i.test(r.url) ? r.url.replace(/#.*$/, "") + "#zoom=100" : r.url;
    requestAnimationFrame(() => { if (viewing === e) vframe.src = target; });
  }
  function closeViewer() {
    stopRec();
    viewing = null;
    panel.classList.add("hidden");
    panel.textContent = "";
    vframe.src = "about:blank";
    view.classList.remove("viewing");
    viewer.classList.add("hidden");
    if (!view.classList.contains("hidden")) render(); // read state may have changed while viewing
  }
  vback.addEventListener("click", closeViewer);
  vread.addEventListener("click", () => viewing && toggleRead(viewing));
  vsend.addEventListener("click", () => {
    if (!viewing) return;
    const open = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !open);
    if (open) buildPanel(viewing); else stopRec();
  });
  function paintViewerBar() {
    const isDoc = viewing && viewing.type === "document";
    vread.classList.toggle("hidden", !isDoc);
    vsend.classList.toggle("hidden", !isDoc);
    if (isDoc) vread.textContent = isRead(viewing.id) ? "Mark unread" : "Mark read";
  }
  vext.addEventListener("click", () => viewing && window.api.registryAction(viewing.id, viewing.isUrl ? "openPdf" : "open"));
  vfolder.addEventListener("click", () => viewing && window.api.registryAction(viewing.id, "reveal"));

  // --- comment / send panel (v1.64.0) ---------------------------------------
  // Every document is actionable: Iddo reads it, comments (typed or by voice) and sends name + full path +
  // comment to an agent. Delivery reuses renderer.js's own send path via window.libraryBridge, never a new
  // transport. Recipients: the agent that wrote it, then the COO, then everyone else (collapsed).
  const CHIPS = ["build this", "implement this", "park", "I read it, no action", "question"];
  const normName = (s) => String(s || "").toLowerCase().replace(/\bagent\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  function findWriter(entryAgent, list) {
    const n = normName(entryAgent);
    if (!n) return null;
    const exact = list.find((a) => normName(a.folderName) === n || normName(a.displayName) === n);
    if (exact) return exact;
    if (n.length < 4) return null;
    return list.find((a) => [normName(a.folderName), normName(a.displayName)].some((x) => x.length >= 4 && (x.includes(n) || n.includes(x)))) || null;
  }
  const findCoo = (list) => list.find((a) => /^coo\b/.test(normName(a.folderName)) || /^coo\b/.test(normName(a.displayName))) || null;
  const label = (a) => (a.displayName && a.displayName !== a.folderName ? a.displayName : a.folderName);

  let rec = null; // active voice recording { stream, recorder, chunks, timer }
  function stopRec(discard) {
    if (!rec) return;
    const r = rec;
    rec = null;
    clearTimeout(r.timer);
    r.discard = !!discard;
    try { if (r.recorder.state !== "inactive") r.recorder.stop(); } catch (err) {}
    r.stream.getTracks().forEach((t) => t.stop());
  }

  function buildPanel(e) {
    panel.textContent = "";
    const bridge = window.libraryBridge;
    const list = bridge ? bridge.agents() : [];
    const writer = findWriter(e.agent, list);
    const coo = findCoo(list);
    let to = (writer || coo || {}).path || null;
    let chip = "";
    let sending = false;

    const head2 = el("div", "library-send-head");
    head2.appendChild(el("div", "library-send-title", "Comment / send"));
    const closeP = el("button", "library-btn library-send-close", "Close");
    closeP.addEventListener("click", () => { stopRec(); panel.classList.add("hidden"); });
    head2.appendChild(closeP);
    panel.appendChild(head2);
    panel.appendChild(el("div", "library-send-doc", e.title));
    panel.appendChild(el("div", "library-send-path", e.path || "(no local file path)"));

    // recipients
    panel.appendChild(el("div", "library-send-label", "Send to"));
    const rcpts = el("div", "library-send-rcpts");
    const rBtns = [];
    const addRcpt = (parent, a, prefix) => {
      const b = el("button", "library-rcpt", prefix + label(a));
      b.dataset.path = a.path;
      b.addEventListener("click", () => { to = a.path; paintRcpt(); });
      rBtns.push(b);
      parent.appendChild(b);
    };
    if (writer) addRcpt(rcpts, writer, "Writer: ");
    else if (e.agent) rcpts.appendChild(el("span", "library-rcpt-none", `Writer: ${e.agent} (not in this app)`));
    if (coo && (!writer || coo.path !== writer.path)) addRcpt(rcpts, coo, "");
    panel.appendChild(rcpts);
    const others = list.filter((a) => (!writer || a.path !== writer.path) && (!coo || a.path !== coo.path));
    if (others.length) {
      const det = el("details", "library-send-others");
      det.appendChild(el("summary", null, `Other agents (${others.length})`));
      const wrap = el("div", "library-send-rcpts");
      others.forEach((a) => addRcpt(wrap, a, ""));
      det.appendChild(wrap);
      panel.appendChild(det);
    }
    const paintRcpt = () => {
      rBtns.forEach((b) => b.classList.toggle("on", b.dataset.path === to));
      if (to && others.some((a) => a.path === to)) { const d = panel.querySelector(".library-send-others"); if (d) d.open = true; }
    };

    // quick actions
    panel.appendChild(el("div", "library-send-label", "Quick action"));
    const chips = el("div", "library-send-chips");
    const cBtns = [];
    CHIPS.forEach((c) => {
      const b = el("button", "library-chip", c);
      b.addEventListener("click", () => { chip = chip === c ? "" : c; cBtns.forEach((x) => x.classList.toggle("on", x.textContent === chip)); });
      cBtns.push(b);
      chips.appendChild(b);
    });
    panel.appendChild(chips);

    // comment + mic
    panel.appendChild(el("div", "library-send-label", "Comment"));
    const ta = el("textarea", "library-send-text");
    ta.rows = 4;
    ta.placeholder = "Type, or press the mic and speak...";
    panel.appendChild(ta);
    const row = el("div", "library-send-row");
    const mic = el("button", "library-btn library-mic", "Mic");
    mic.title = "Dictate the comment (local speech recognition)";
    const sendBtn = el("button", "library-btn library-btn-primary library-send-go", "Send");
    const st = el("div", "library-send-status");
    row.append(mic, sendBtn);
    panel.append(row, st);
    const say = (m, bad) => { st.textContent = m || ""; st.classList.toggle("bad", !!bad); };

    mic.addEventListener("click", async () => {
      if (rec) { stopRec(); return; }
      if (!bridge) { say("Dictation is not available here.", true); return; }
      try {
        bridge.warmVoice();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const r = { stream, recorder, chunks: [], timer: null, discard: false };
        recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) r.chunks.push(ev.data); };
        recorder.onstop = async () => {
          mic.classList.remove("recording");
          mic.textContent = "Mic";
          if (r.discard || !r.chunks.length) return;
          mic.disabled = true;
          say("Transcribing... (the first clip can take up to a minute)");
          const res = await bridge.dictate(new Blob(r.chunks, { type: recorder.mimeType || "audio/webm" }), (m) => say(m));
          mic.disabled = false;
          if (!res.ok) { say(res.error || "Transcription failed.", true); return; }
          if (!res.text || /^[\s.…-]*$/.test(res.text)) { say("Nothing was heard - try again closer to the mic.", true); return; }
          ta.value = ta.value && !/\s$/.test(ta.value) ? ta.value + " " + res.text : ta.value + res.text;
          say("Transcribed - review it, then Send.");
        };
        recorder.start();
        r.timer = setTimeout(() => stopRec(), 180000);
        rec = r;
        mic.classList.add("recording");
        mic.textContent = "Stop";
        say("Recording... press Stop when done.");
      } catch (err) {
        say("Could not use the microphone: " + err.message, true);
      }
    });

    sendBtn.addEventListener("click", async () => {
      if (sending) return;
      const comment = ta.value.trim();
      const target = list.find((a) => a.path === to);
      if (!target) { say("Pick who to send it to.", true); return; }
      if (!e.path) { say("This entry has no local file path to send.", true); return; }
      if (!chip && !comment) { say("Choose a quick action or write a comment first.", true); return; }
      sending = true;
      sendBtn.disabled = true;
      say("Sending...");
      const text = [
        `Iddo read the document "${e.title}" in the Library and sends it to you.`,
        `Document: ${e.title}`,
        `Full path: ${e.path}`,
        `Action: ${chip || "comment only"}`,
        `Comment: ${comment || "(none)"}`,
      ].join("\n");
      const res = await bridge.send(target.path, text).catch((err) => ({ ok: false, error: String(err) }));
      sending = false;
      sendBtn.disabled = false;
      if (!res.ok) { say(res.error || "Could not send it.", true); return; }
      const rec2 = { to: target.folderName, toName: label(target), action: chip, comment };
      const saved = await window.api.libraryStateOp({ op: "history", id: e.id, record: rec2 }).catch(() => ({ ok: false }));
      if (saved && saved.ok) {
        (libState.history[e.id] = sentList(e.id)).push({ at: new Date().toISOString(), ...rec2 });
        libState.history[e.id] = libState.history[e.id].slice(-50);
      }
      await setRead(e, true); // sending means he has read it
      say(`Sent to ${label(target)}${res.how === "queued" ? " (queued - it is busy and will get it next)" : ""}.`);
      ta.value = "";
      chip = "";
      cBtns.forEach((x) => x.classList.remove("on"));
      paintHist();
    });

    // history
    panel.appendChild(el("div", "library-send-label", "Sent before"));
    const hist = el("div", "library-send-hist");
    panel.appendChild(hist);
    const paintHist = () => {
      hist.textContent = "";
      const items = sentList(e.id).slice().reverse();
      if (!items.length) { hist.appendChild(el("div", "library-send-none", "Nothing sent about this document yet.")); return; }
      items.forEach((h) => {
        const it = el("div", "library-hist-item");
        const when = new Date(h.at);
        const stamp = isNaN(when) ? "" : when.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        it.appendChild(el("div", "library-hist-head", `${stamp} - to ${h.toName || h.to}${h.action ? " - " + h.action : ""}`));
        if (h.comment) it.appendChild(el("div", "library-hist-comment", h.comment));
        hist.appendChild(it);
      });
    };
    paintRcpt();
    paintHist();
    if (!list.length) say("No agents are loaded in this app.", true);
  }

  function card(e) {
    const c = el("div", "library-card" + (e.type === "image" ? " library-card-image" : ""));
    if (e.type === "image") {
      const frame = el("div", "library-thumb");
      if (e.thumbnail) {
        const img = el("img");
        // Not lazy: this panel is shown/hidden via a class toggle, not real
        // navigation, and Chromium's lazy-load intersection observer often
        // never fires for an <img> created while its container is still
        // display:none - every thumbnail silently never loaded (2026-09-28,
        // caught once 11 images existed to reveal the pattern; text-only
        // cards rendered fine since that part is synchronous). The list is
        // at most dozens of images, so eager loading costs nothing here.
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
    if (e.type === "document") {
      const rd = isRead(e.id);
      c.classList.add(rd ? "library-card-read" : "library-card-unread");
      const dot = el("button", "library-read-dot " + (rd ? "is-read" : "is-unread"));
      dot.title = rd ? "Read - click to mark unread" : "Unread - click to mark read";
      dot.setAttribute("aria-label", dot.title);
      dot.addEventListener("click", () => toggleRead(e));
      titleRow.appendChild(dot);
    }
    const title = el("button", "library-card-title", e.title);
    title.title = e.link;
    title.addEventListener("click", () => act(e, "open"));
    titleRow.appendChild(title);
    if (e.status !== "active") titleRow.appendChild(el("span", "library-tag", e.status));
    if (e.missing) titleRow.appendChild(el("span", "library-tag library-tag-bad", "file missing"));
    if (e.stale) titleRow.appendChild(el("span", "library-tag", `unconfirmed ${e.staleDays} days`));
    const idle = idleDays(e);
    if (tab === "project" && stage !== "active" && idle > IDLE_DAYS) {
      titleRow.appendChild(el("span", "library-tag library-tag-bad", `no movement ${idle} days`));
    }
    main.appendChild(titleRow);
    if (e.description) main.appendChild(el("div", "library-card-desc", e.description));
    const meta = el("div", "library-card-meta");
    // Iddo, 2026-09-28: for images specifically, wants the filename first,
    // then who made it, then size and where it actually lives on disk -
    // that's what he reaches for when browsing renders, not the topic/date
    // that matter more for documents and projects.
    const metaParts = e.type === "image"
      ? [linkLabel(e), e.agent, fmtSize(e.fileSize), e.folder]
      : [e.agent, e.topic, fmtDate(e.updatedAt), linkLabel(e)];
    metaParts.filter(Boolean).forEach((m, i) => {
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
    if (e.type === "document") {
      const rb = el("button", "library-btn", isRead(e.id) ? "Mark unread" : "Mark read");
      rb.addEventListener("click", () => toggleRead(e));
      actions.appendChild(rb);
      const sb = el("button", "library-btn library-btn-primary", "Comment / send");
      sb.addEventListener("click", () => openViewer(e, { panel: true }));
      actions.appendChild(sb);
    }
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
    if (e.hasWebCopy) {
      const webBtn = el("button", "library-btn", "Web version");
      webBtn.addEventListener("click", () => act(e, "openWeb"));
      actions.appendChild(webBtn);
    }
    const copy = el("button", "library-btn", "Copy link");
    copy.addEventListener("click", () => act(e, "copy"));
    actions.appendChild(copy);
    main.appendChild(actions);
    const sent = e.type === "document" ? sentList(e.id) : [];
    if (sent.length) {
      const last = sent[sent.length - 1];
      const line = el("button", "library-card-sent", `Sent ${sent.length}x - last to ${last.toName || last.to}${last.action ? ", " + last.action : ""}, ${fmtDate(last.at)}`);
      line.title = "Show what was sent";
      line.addEventListener("click", () => openViewer(e, { panel: true }));
      main.appendChild(line);
    }
    // Iddo (09-23): only the latest version of a document shows; older ones sit in fine print.
    if (e.olderVersions && e.olderVersions.length) {
      const det = el("details", "library-older");
      det.appendChild(el("summary", null, `Older versions (${e.olderVersions.length})`));
      e.olderVersions.forEach((v, i) => {
        const row = el("button", "library-older-row" + (v.exists ? "" : " library-older-gone"), `${v.name || "older version"}${v.date ? " - replaced " + fmtDate(v.date) : ""}${v.exists ? "" : " (file missing)"}`);
        row.addEventListener("click", () => act(e, "openOlder:" + i));
        det.appendChild(row);
      });
      main.appendChild(det);
    }
    c.appendChild(main);
    return c;
  }

  function idleDays(e) {
    const t = Date.parse(e.updatedAt || "");
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : 0;
  }

  // Which entries belong to a stage. Active is projects only; Ideas and
  // Researched also take documents carrying that stage (a research paper).
  function inStage(e, st) {
    return st === "active" ? e.type === "project" && e.stage === "active" : e.stage === st;
  }

  function visible(type) {
    // Iddo, 2026-09-28: images shouldn't be gated by the Archived checkbox at
    // all - "I don't understand why you have archived images, it makes no
    // sense." Superseded concept renders are still real work he wants to
    // browse, unlike a finished project or an old document. Projects/
    // documents keep the active-only default.
    return entries.filter((e) => e.type === type && (type === "image" || showArchived || e.status === "active"));
  }

  function stageItems(st) {
    return entries.filter((e) => inStage(e, st) && (showArchived || e.status === "active"));
  }

  function docCounts() {
    const all = visible("document");
    const read = all.filter((e) => isRead(e.id)).length;
    return { all: all.length, read, unread: all.length - read };
  }

  async function setRead(e, value) {
    const prev = libState.read[e.id];
    if (value) libState.read[e.id] = { at: new Date().toISOString() }; else delete libState.read[e.id];
    paintViewerBar();
    updateCounts();
    const r = await window.api.libraryStateOp({ op: "read", id: e.id, value: !!value }).catch(() => ({ ok: false }));
    if (!r || !r.ok) {
      if (prev) libState.read[e.id] = prev; else delete libState.read[e.id];
      paintViewerBar();
      updateCounts();
      flash((r && r.error) || "Could not save the read state.");
    }
    return !!(r && r.ok);
  }
  async function toggleRead(e) {
    const keep = body.scrollTop;
    await setRead(e, !isRead(e.id));
    if (!viewing) { render(); body.scrollTop = keep; }
  }

  function updateCounts() {
    const dc = docCounts();
    const ub = navBtns.get("document").querySelector(".library-nav-unread");
    ub.textContent = String(dc.unread);
    vcU.querySelector(".library-docfilter-text").textContent = `Unread ${dc.unread}`;
    vcR.querySelector(".library-docfilter-text").textContent = `Read ${dc.read}`;
    ub.classList.toggle("hidden", dc.unread === 0);
    // the red pill replaces the grey total while anything is unread (the Documents tab shows the total)
    navBtns.get("document").querySelector(".library-nav-count").classList.toggle("hidden", dc.unread > 0);
    docFilterBtns.forEach((b, key) => {
      b.querySelector(".library-docfilter-text").textContent = `${key === "all" ? "All" : key === "unread" ? "Unread" : "Read"} (${dc[key]})`;
      b.classList.toggle("active", readFilter === key);
    });
    TABS.forEach((t) => {
      const b = navBtns.get(t.type);
      const n = t.type === "project" ? STAGES.reduce((a, s) => a + stageItems(s.stage).length, 0) : visible(t.type).length;
      b.querySelector(".library-nav-count").textContent = String(n);
    });
  }

  function render() {
    updateCounts();
    const libOpen = document.body.classList.contains("library-open");
    navBtns.forEach((b, type) => b.classList.toggle("active", libOpen && type === tab));
    tabBtns.forEach((b, type) => {
      b.classList.toggle("active", type === tab);
      const n = type === "project" ? STAGES.reduce((a, s) => a + stageItems(s.stage).length, 0) : visible(type).length;
      b.textContent = `${TABS.find((t) => t.type === type).label} (${n})`;
    });
    stageBar.classList.toggle("hidden", tab !== "project");
    docBar.classList.toggle("hidden", tab !== "document");
    // It no longer filters anything on this tab (see visible() above), so
    // showing it here would just be a checkbox that lies about doing
    // something - Iddo: "the archive should be removed."
    archLabel.classList.toggle("hidden", tab === "image");
    stageBtns.forEach((b, st) => {
      b.classList.toggle("active", st === stage);
      b.textContent = `${STAGES.find((x) => x.stage === st).label} (${stageItems(st).length})`;
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
    const pool = tab === "project" ? stageItems(stage) : visible(tab);
    const rows = pool.filter((e) =>
      (!agentFilter || e.agent === agentFilter) &&
      (tab !== "document" || readFilter === "all" || (readFilter === "read") === isRead(e.id)) &&
      (!query || [e.title, e.description, e.topic, e.agent].join(" ").toLowerCase().includes(query)));
    if (!rows.length) {
      const t = tab === "project" ? STAGES.find((x) => x.stage === stage) : TABS.find((x) => x.type === tab);
      body.appendChild(el("p", "library-empty", tab === "document" && readFilter !== "all" && !query && !agentFilter ? (readFilter === "unread" ? "Nothing unread - everything is marked read." : "Nothing is marked read yet.") : query || agentFilter ? "Nothing matches." : t.empty));
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

  window.api.libraryStateGet().then((s) => {
    if (s && s.read) libState = { read: s.read, history: s.history || {} };
    updateCounts();
    if (document.body.classList.contains("library-open")) render();
  }).catch((err) => console.error("[library] state", err));
  refresh();
  setInterval(refresh, POLL_MS);
})();

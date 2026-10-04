// Header controls, the Tasks panel, and session-state avatar rings.
// Live since v1.37.0; built and reviewed first as sandbox-only proposals
// (v1.35.x-v1.36.x), where the panel and rings ran on sample data. They were
// graduated only once overview.js could feed them real state.
//
// SAFETY RULE FOR EVERYTHING IN HERE: never re-implement behaviour. The
// original header controls stay in the DOM, hidden, and every new control
// forwards its click to the real button via .click(). A failure here is
// cosmetic, not functional - and reverting is removing one <script> and one
// <link> from index.html.
//
//   1. The header, restructured. Iddo: "square and round buttons next to each
//      other with different strange spacing - it just doesn't look like a
//      proper UI." Ten peer buttons become a view switcher, a Tasks button
//      and one Session menu.
//   2. The task panel he asked for: a right-side slide-out showing that
//      agent's open work as two stacked sets - Telegram tasks awaiting his
//      approval, and the agent's own OPEN NOW list - plus an all-agents view.
//   3. Session state (working / open / not running) as the avatar ring.

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // --- 1. Header ------------------------------------------------------------
  // The ten buttons are not peers. Four are view switches (mutually exclusive,
  // so they belong in a segmented control that also shows which view you are
  // in - today nothing does). Six are session actions, several destructive,
  // which have no business sitting one stray click from Reset Session.
  const VIEWS = [
    { label: "Chat", btn: null, icon: "chat", tip: "Chat: the normal message view (the default)." },
    { label: "Terminal", btn: "raw-terminal-toggle-btn", icon: "terminal", tip: "Terminal: the plain text terminal Claude Code actually runs in (the old Raw Terminal button)." },
    { label: "Chats", btn: "chats-toggle-btn", icon: "chats", tip: "Chats: this agent's other past and parallel conversations; switch, start or rename." },
    { label: "History", btn: "history-toggle-btn", icon: "history", tip: "History: this agent's full message history, day by day." },
  ];
  const SESSION_ACTIONS = [
    "handoff-reset-btn",
    "handoff-all-btn",
    "reset-session-btn",
    "restart-session-btn",
    "pause-agent-btn",
    "model-picker-btn",
    "save-to-master-btn",
  ];

  // --- v1.71.0 helpers: one line-icon set, and the meter readings -------------
  // 16px, stroke 1.75, currentColor (UI rules 2). Built as SVG nodes, no innerHTML, no emoji.
  const ICONS = {
    bell: [["path", { d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" }], ["path", { d: "M10.3 21a1.94 1.94 0 0 0 3.4 0" }]],
    chat: [["path", { d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" }]],
    terminal: [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "m7 9 3 3-3 3" }], ["path", { d: "M13 15h4" }]],
    chats: [["path", { d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" }]],
    history: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7v5l3 2" }]],
    check: [["path", { d: "M20 6 9 17l-5-5" }]],
    dots: [["path", { d: "M5 12h.01M12 12h.01M19 12h.01" }]],
    chevron: [["path", { d: "m6 9 6 6 6-6" }]],
  };
  function icon(name, cls) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "xp-ico" + (cls ? " " + cls : ""));
    (ICONS[name] || []).forEach(([tag, attrs]) => {
      const n = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k]));
      svg.appendChild(n);
    });
    return svg;
  }
  window.xpIcon = icon;

  // Meter level: green under 50, amber 50 to 80, red over 80 - the same rule for all three (UI rules 3).
  function meterLevel(pct) { return pct > 80 ? "crit" : pct >= 50 ? "warn" : "ok"; }
  window.xpMeterLevel = meterLevel;

  const METERS = [
    ["five-hour-usage", "5h", "5-hour usage"],
    ["weekly-usage", "7d", "7-day usage"],
    ["context-usage", "Context", "Context window used"],
  ];
  // renderer.js keeps writing "27% (5h)" / "125K tokens (63%)" with textContent. This re-dresses the same element as
  // label + number + bar. It reads the percent from the text, never computes usage itself.
  function wrapMeter(el, label, name) {
    if (el.querySelector(":scope > .xp-m-l")) return;                 // already dressed, text not rewritten since
    const raw = el.textContent;
    const m = /(\d+(?:\.\d+)?)\s*%/.exec(raw);
    if (!m) {                                                          // estimate fallback with no percent: plain muted text
      el.classList.remove("xp-meter");
      delete el.dataset.xpPct; delete el.dataset.xpLevel;
      el.removeAttribute("role");
      return;
    }
    const pct = Math.min(100, Math.round(parseFloat(m[1])));
    el.dataset.xpRaw = raw;
    el.dataset.xpPct = String(pct);
    el.dataset.xpLevel = meterLevel(pct);
    el.classList.add("xp-meter");
    el.style.setProperty("--pct", pct + "%");
    el.setAttribute("role", "meter");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    el.setAttribute("aria-valuenow", String(pct));
    el.setAttribute("aria-label", name + " " + pct + " percent");
    const l = document.createElement("span"); l.className = "xp-m-l"; l.textContent = label;
    const n = document.createElement("span"); n.className = "xp-m-n"; n.textContent = pct + "%";
    const bar = document.createElement("span"); bar.className = "xp-m-bar";
    const fill = document.createElement("i"); bar.appendChild(fill);
    el.textContent = "";
    el.append(l, n, bar);
    if (el.id === "context-usage") {
      const t = $("xp-tokens");
      if (t) { t.textContent = raw.split("(")[0].trim(); t.classList.toggle("hidden", !t.textContent); }
    }
  }
  let meterObs = null;
  function watchMeters() {
    if (meterObs) return;
    const run = () => {
      METERS.forEach(([id, label, name]) => { const el = $(id); if (el) wrapMeter(el, label, name); });
      const ctx = $("context-usage"), t = $("xp-tokens");
      if (ctx && t && ctx.classList.contains("hidden")) t.classList.add("hidden");
    };
    meterObs = new MutationObserver(() => { run(); meterObs.takeRecords(); });
    METERS.forEach(([id]) => { const el = $(id); if (el) meterObs.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] }); });
    run();
    meterObs.takeRecords();
  }
  // Always-visible key to the colours (Iddo will not remember encodings). Dropped first on a narrow window.
  function buildMeterLegend() {
    const lg = document.createElement("span");
    lg.className = "xp-legend";
    lg.title = "Meter colours (5h, 7d, Context): green under 50%, amber 50 to 80%, red over 80%. Every meter also shows its number. " +
      "Blue 'Needs you' = decisions waiting for you. The Keep going switch is the only control in this row.";
    [["ok", "<50%"], ["warn", "50-80%"], ["crit", ">80%"], ["old", "old"]].forEach(([lvl, txt]) => {
      const it = document.createElement("span");
      it.className = "xp-lg-item";
      const sw = document.createElement("i");
      sw.className = "xp-lg-sw " + lvl;
      it.append(sw, txt);
      lg.appendChild(it);
    });
    return lg;
  }

  function buildHeader() {
    const header = $("chat-header");
    if (!header || header.dataset.xpDone) return;

    // The five status readings go in their own box that is allowed to clip.
    // Without this the header overflowed at 1266px wide and pushed the Session
    // menu clean off the right edge - present in the DOM, unreachable on
    // screen, which is how Iddo noticed buttons were "missing". Status is the
    // right thing to sacrifice when space runs out; controls are not.
    // 2026-09-29: order here IS clip priority - .xp-status's overflow:hidden
    // clips from the end of this list first when the window is narrow (Iddo's
    // normal, non-fullscreen case - see memory iddo-not-fullscreen-ui-must-be-
    // legible-small). context-usage used to sit second-to-last, so the one
    // reading Iddo explicitly asked to always have on screen ("just a number
    // on top", 2026-09-28) was the very first thing this app hid from him.
    // Reordered so the two he actually watches moment-to-moment (rate-limit
    // %, and now token count) survive longest; the rougher monthly estimate
    // and the cache-status debug reading are now what gets sacrificed first.
    // v1.71.0 Option B: TWO rows. Row 1 = identity (avatar, name, role) on the left and the actions on the right.
    // Row 2 (.xp-status) = status only: Keep going, the 5h / 7d / Context meters, model chip, a muted detail line, a legend.
    // Order inside row 2 is also clip priority (the detail line and legend are dropped first on a narrow window).
    // Every id is kept and moved, never recreated, so renderer.js keeps writing to the same elements.
    const row1 = document.createElement("div");
    row1.className = "xp-row1";
    ["chat-avatar-slot", "chat-header-text"].forEach((id) => { const el = $(id); if (el) row1.appendChild(el); });
    header.appendChild(row1);

    const status = document.createElement("div");
    status.className = "xp-status";
    const kg = $("keepgoing-btn");           // keepgoing.js may not have created it yet; it docks itself later
    if (kg) status.appendChild(kg);
    const vdiv = document.createElement("span");
    vdiv.className = "xp-vdiv";
    vdiv.setAttribute("aria-hidden", "true");
    status.appendChild(vdiv);
    ["five-hour-usage", "weekly-usage", "context-usage", "model-badge"].forEach((id) => {
      const el = $(id);
      if (el) status.appendChild(el);
    });
    // The muted detail line: token count (taken from the Context reading), messages this month, cache timer.
    const detail = document.createElement("span");
    detail.className = "xp-detail";
    const tokens = document.createElement("span");
    tokens.id = "xp-tokens";
    tokens.className = "xp-detail-item hidden";
    detail.appendChild(tokens);
    ["monthly-usage", "cache-status"].forEach((id) => {
      const el = $(id);
      if (el) detail.appendChild(el);
    });
    status.appendChild(detail);
    status.appendChild(buildMeterLegend());
    header.appendChild(status);
    try { watchMeters(); } catch (e) { console.error("[header-tasks] meters", e); }

    const controls = document.createElement("div");
    controls.className = "xp-controls";

    // Segmented view switcher (icon + word; words drop away on a narrow window, icons stay).
    const seg = document.createElement("div");
    seg.className = "xp-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "View");
    VIEWS.forEach((v, i) => {
      const b = document.createElement("button");
      b.className = "xp-seg-btn" + (i === 0 ? " active" : "");
      b.setAttribute("aria-label", v.label + " view");
      b.title = v.tip;
      b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
      b.appendChild(icon(v.icon));
      const lbl = document.createElement("span");
      lbl.className = "xp-lbl";
      lbl.textContent = v.label;
      b.appendChild(lbl);
      b.addEventListener("click", () => {
        seg.querySelectorAll(".xp-seg-btn").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-pressed", "false"); });
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
        // "Chat" is the absence of the other views; the real Raw Terminal
        // button is a toggle, so leaving it is clicking it again.
        const raw = $("raw-terminal-toggle-btn");
        if (!v.btn && raw && document.body.dataset.xpView === "Terminal") raw.click();
        if (v.btn) { const t = $(v.btn); if (t) t.click(); }
        document.body.dataset.xpView = v.label;
      });
      seg.appendChild(b);
    });
    controls.appendChild(seg);

    // Tasks toggle, with a count so waiting work is visible without opening it.
    const tasksBtn = document.createElement("button");
    tasksBtn.className = "xp-tasks-btn";
    tasksBtn.title = "Open the Tasks panel: this agent's open work and anything waiting for your approval. The number is how many open items there are.";
    tasksBtn.setAttribute("aria-label", "Tasks");
    tasksBtn.appendChild(icon("check"));
    // Built from nodes rather than innerHTML throughout this file: the task
    // text these controls will eventually carry comes from dictated voice
    // notes and from other agents, i.e. not content this code authored.
    const tlbl = document.createElement("span");
    tlbl.className = "xp-lbl";
    tlbl.textContent = "Tasks";
    tasksBtn.appendChild(tlbl);
    const count = document.createElement("span");
    count.className = "xp-count";
    count.textContent = "0";
    tasksBtn.appendChild(count);
    tasksBtn.addEventListener("click", () => document.body.classList.toggle("xp-panel-open"));
    controls.appendChild(tasksBtn);

    // One menu for everything that changes or ends the session (Reset, Restart, Pause, Model, Save to master file, handoff).
    const wrap = document.createElement("div");
    wrap.className = "xp-menu-wrap";
    const menuBtn = document.createElement("button");
    menuBtn.className = "xp-menu-btn";
    menuBtn.title = "Session actions: handoff and reset, restart, pause, choose the model, save to the master file.";
    menuBtn.setAttribute("aria-label", "Session menu");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.appendChild(icon("dots"));
    const slbl = document.createElement("span");
    slbl.className = "xp-lbl";
    slbl.textContent = "Session";
    menuBtn.appendChild(slbl);
    menuBtn.appendChild(icon("chevron", "xp-chev"));
    const menu = document.createElement("div");
    menu.className = "xp-menu";
    SESSION_ACTIONS.forEach((id) => {
      const orig = $(id);
      if (!orig) return;
      const item = document.createElement("button");
      item.className = "xp-menu-item" + (id === "handoff-reset-btn" ? " accent" : "");
      item.textContent = orig.textContent;
      item.title = orig.title || "";
      item.addEventListener("click", () => { menu.classList.remove("open"); orig.click(); });
      menu.appendChild(item);
    });
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); menuBtn.setAttribute("aria-expanded", menu.classList.contains("open") ? "true" : "false"); });
    document.addEventListener("click", () => { menu.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); });
    wrap.appendChild(menuBtn);
    wrap.appendChild(menu);
    controls.appendChild(wrap);

    row1.appendChild(controls);

    header.dataset.xpDone = "1";
    // Publish the real header height so the drawer can sit below it rather
    // than guessing a number that breaks when the header wraps or the banner
    // changes size.
    const setH = () => document.documentElement.style.setProperty("--xp-header-h", header.offsetHeight + "px");
    setH();
    new ResizeObserver(setH).observe(header);
    document.body.dataset.xpView = "Chat";
    document.body.classList.add("xp-header");
  }


  // --- 2. Task panel --------------------------------------------------------
  // Real data since v1.37.0 (main.js "get-agent-overview", see overview.js):
  // the Telegram queue, each agent's own OPEN NOW list, and live session
  // state. The layout is the one Iddo saw in the sandbox - two stacked sets
  // per agent, and a triage view across all agents that leads with what is
  // waiting on him rather than concatenating every list.
  const POLL_MS = 10000;
  let overview = null;
  let scopeKey = "agent";
  let body = null;

  function activeFolder() {
    // activeAgentPath is renderer.js's top-level `let` - shared global scope.
    if (typeof activeAgentPath === "undefined" || !activeAgentPath || !overview) return null;
    return overview.agents.find((a) => a.path === activeAgentPath) || null;
  }

  function contextAttention(a) {
    if (!a.context) return null;
    if (typeof window.guardUsageIsStale === "function" && window.guardUsageIsStale(a.path, a.context)) return null;
    return `${Math.round(a.context.contextTokens / 1000)}K context - needs a handoff`;
  }

  function emptyNote(text) {
    const p = document.createElement("p");
    p.className = "xp-empty";
    p.textContent = text;
    return p;
  }

  function section(title, note, items, opts = {}) {
    const sec = document.createElement("section");
    sec.className = "xp-sec";
    const h = document.createElement("div");
    h.className = "xp-sec-head";
    const hLabel = document.createElement("span");
    hLabel.textContent = title;
    const hCount = document.createElement("span");
    hCount.className = "xp-sec-count";
    hCount.textContent = String(items.length);
    h.appendChild(hLabel);
    h.appendChild(hCount);
    sec.appendChild(h);
    if (note) {
      const n = document.createElement("p");
      n.className = "xp-sec-note";
      n.textContent = note;
      sec.appendChild(n);
    }
    if (!items.length) {
      sec.appendChild(emptyNote(opts.empty || "Nothing here."));
      return sec;
    }
    const ul = document.createElement("ul");
    ul.className = "xp-list";
    // Items are { text, taskId? }. The text is dictated or agent-written, so
    // it only ever goes in via textContent.
    items.forEach((it) => {
      const li = document.createElement("li");
      if (opts.approvable && it.taskId) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.taskId = it.taskId;
        li.appendChild(cb);
      }
      const span = document.createElement("span");
      span.textContent = it.text;
      li.appendChild(span);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    const ids = items.map((it) => it.taskId).filter(Boolean);
    if (opts.approvable && ids.length) {
      const row = document.createElement("div");
      row.className = "xp-actions";
      const status = document.createElement("span");
      status.className = "xp-approve-status";
      const run = async (chosen) => {
        if (!chosen.length) { status.textContent = "Tick a task first."; return; }
        status.textContent = "Approving…";
        const r = await window.api.approveTelegramTasks(chosen).catch((e) => ({ ok: false, output: String(e) }));
        status.textContent = r.ok ? `Approved ${chosen.length}.` : "Failed: " + (r.output || "").slice(0, 120);
        refresh();
      };
      const sel = document.createElement("button");
      sel.className = "xp-approve";
      sel.textContent = "Approve selected";
      sel.addEventListener("click", () =>
        run([...sec.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.dataset.taskId)));
      const all = document.createElement("button");
      all.className = "xp-approve-all";
      all.textContent = "Approve all";
      all.addEventListener("click", () => run(ids));
      row.appendChild(sel);
      row.appendChild(all);
      row.appendChild(status);
      sec.appendChild(row);
    }
    return sec;
  }

  function stateLabel(a) {
    if (a.state === "working") return `working now (${Math.max(1, Math.round(a.sinceMs / 60000))} min)`;
    return a.state === "ready" ? "open, waiting" : "not running";
  }

  function render() {
    if (!body) return;
    // Keep ticks across the 10s refresh - rebuilding would silently clear a
    // half-made selection.
    const ticked = new Set([...body.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.dataset.taskId));
    body.textContent = "";
    if (!overview) { body.appendChild(emptyNote("Loading…")); return; }
    if (scopeKey === "agent") {
      const a = activeFolder();
      if (!a) { body.appendChild(emptyNote("Select an agent to see its open tasks.")); return; }
      const pending = a.telegram.filter((t) => t.status === "pending").map((t) => ({ text: t.body, taskId: t.id }));
      const approved = a.telegram.filter((t) => t.status === "approved").map((t) => ({ text: "Approved: " + t.body }));
      body.appendChild(section("From Telegram", "Dictated while away - not acted on until you approve.",
        pending.concat(approved), { approvable: true, empty: "No Telegram tasks for this agent." }));
      body.appendChild(section("Agreed with this agent",
        a.openFile ? `This agent's OPEN NOW list (${a.openFile}).` : "This agent keeps no OPEN NOW list yet.",
        a.openItems.map((t) => ({ text: t })), { empty: "Its OPEN NOW list is empty." }));
    } else {
      const waiting = [];
      overview.unassigned.forEach((t) => waiting.push({ text: "Unassigned - " + t.body }));
      overview.agents.forEach((a) => a.telegram.filter((t) => t.status === "pending")
        .forEach((t) => waiting.push({ text: `${a.displayName} - approve: ${t.body}`, taskId: t.id })));
      const attention = [];
      overview.agents.forEach((a) => {
        const ctx = contextAttention(a);
        a.attention.concat(ctx ? [ctx] : []).forEach((x) => attention.push({ text: `${a.displayName} - ${x}` }));
      });
      const inprog = overview.agents.map((a) => ({
        text: `${a.displayName} - ${stateLabel(a)} - ${a.openItems.length} on its list`,
      }));
      body.appendChild(section("Waiting on you", "Telegram approvals and unplaced tasks, across every agent.",
        waiting, { approvable: true, empty: "Nothing waiting on you." }));
      body.appendChild(section("Needs attention", "Halted, paused, long-running, or out of room.",
        attention, { empty: "Nothing needs attention." }));
      body.appendChild(section("In progress", "What each agent is doing now, and how much is on its list.", inprog));
    }
    body.querySelectorAll("input[type=checkbox]").forEach((c) => { if (ticked.has(c.dataset.taskId)) c.checked = true; });
  }

  function updateCount() {
    const count = document.querySelector(".xp-tasks-btn .xp-count");
    if (!count) return;
    const a = activeFolder();
    count.textContent = String(a ? a.openItems.length + a.telegram.filter((t) => t.status === "pending").length : 0);
    const waiting = overview ? overview.unassigned.length +
      overview.agents.reduce((s, x) => s + x.telegram.filter((t) => t.status === "pending").length, 0) : 0;
    count.classList.toggle("xp-count-alert", waiting > 0);
    count.title = waiting ? `${waiting} Telegram task(s) waiting for your approval` : "";
  }

  function buildPanel() {
    if ($("xp-panel")) return;
    const panel = document.createElement("aside");
    panel.id = "xp-panel";

    const head = document.createElement("div");
    head.className = "xp-panel-head";
    const headLabel = document.createElement("span");
    headLabel.textContent = "Open tasks";
    head.appendChild(headLabel);
    const close = document.createElement("button");
    close.className = "xp-panel-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => document.body.classList.remove("xp-panel-open"));
    head.appendChild(close);
    panel.appendChild(head);

    const scope = document.createElement("div");
    scope.className = "xp-scope";
    body = document.createElement("div");
    body.className = "xp-body";
    [["This agent", "agent"], ["All agents", "global"]].forEach(([label, key], i) => {
      const b = document.createElement("button");
      b.className = "xp-scope-btn" + (i === 0 ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        scope.querySelectorAll(".xp-scope-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        scopeKey = key;
        render();
      });
      scope.appendChild(b);
    });

    panel.appendChild(scope);
    panel.appendChild(body);
    document.body.appendChild(panel);
    render();
  }

  // --- 3. Session state, shown by colour ------------------------------------
  // Iddo: colour agents that are live, actively working, and idle differently.
  // Deliberately NOT by recolouring the existing sidebar dot: that dot means
  // HEALTH (from each agent's own state file), a different question from "is
  // it running right now". Session state gets the avatar ring instead.
  // 2026-10-02 (UI-UX design v4, Iddo): one bold run-state icon on the avatar
  // (play = working, pause = open/waiting, stop = not running) plus a needs-you
  // badge in two severities. RED "!" = blocked: the session is halted and cannot
  // progress until Iddo acts. ORANGE "..." = pending: a decision is queued but the
  // agent keeps working. Red wins if both are true. A blocked session never shows
  // the working icon (it is halted by definition).
  function needsOf(a) {
    if (!a) return { kind: null, why: "" };
    if (a.dialogOpen) return { kind: "blocked", why: "Blocked: waiting on a permission prompt - open its tab and answer it" };
    const halt = (a.attention || []).find((t) => /^halted/.test(t));
    if (halt) return { kind: "blocked", why: "Blocked: " + halt };
    // v1.69.0 keep-going: the agent stopped although nobody blocked it. Amber, like "pending" (needs a look, not red).
    try { const ks = window.keepGoingStopped && window.keepGoingStopped(a.path); if (ks) return { kind: "stopped", why: ks }; } catch (e) { /* cosmetic */ }
    const pend = (a.telegram || []).filter((t) => t.status === "pending");
    if (pend.length) return { kind: "pending", why: "Pending: " + pend.length + " decision" + (pend.length > 1 ? "s" : "") + " queued - the agent keeps working" };
    return { kind: null, why: "" };
  }

  function applyAgentStates() {
    if (!overview) return;
    const byFolder = new Map(overview.agents.map((a) => [a.folderName, a]));
    document.querySelectorAll("#agent-list .agent-item").forEach((row) => {
      const a = byFolder.get(row.dataset.folderName);
      const needs = needsOf(a);
      let state = a ? a.state : "idle";
      if (needs.kind === "blocked" && state === "working") state = "ready";
      const key = state + "|" + needs.kind + "|" + needs.why;
      if (row.dataset.xpState === key) return;
      row.dataset.xpState = key;
      row.classList.remove("xp-working", "xp-ready", "xp-idle", "xp-needs-blocked", "xp-needs-pending", "xp-needs-stopped");
      row.classList.add("xp-" + state);
      if (needs.kind) row.classList.add("xp-needs-" + needs.kind);
      const wrap = row.querySelector(".avatar-wrap");
      if (!wrap) return;
      let icon = wrap.querySelector(".xp-state-icon");
      if (!icon) { icon = document.createElement("span"); wrap.appendChild(icon); }
      icon.className = "xp-state-icon " + (state === "working" ? "working" : state === "ready" ? "ready" : "off");
      icon.title = state === "working" ? "Working now" : state === "ready" ? "Open, waiting" : "Not running";
      let badge = wrap.querySelector(".xp-needs-badge");
      if (!needs.kind) { if (badge) badge.remove(); return; }
      if (!badge) { badge = document.createElement("span"); wrap.appendChild(badge); }
      badge.className = "xp-needs-badge " + needs.kind;
      badge.textContent = needs.kind === "blocked" ? "!" : needs.kind === "stopped" ? "\u25CB" : "\u2026";
      badge.title = needs.why;
    });
  }

  function buildLegend() {
    const list = document.getElementById("agent-list");
    if (!list || document.querySelector(".xp-legend")) return;
    const legend = document.createElement("div");
    legend.className = "xp-legend";
    legend.title = "Icon on the avatar = session state. The small dot at the right is the agent's own health reading, a separate thing.";
    const add = (cls, glyph, label) => {
      const item = document.createElement("span");
      const sw = document.createElement("i");
      sw.className = cls;
      if (glyph) sw.textContent = glyph;
      item.appendChild(sw);
      item.append(label);
      legend.appendChild(item);
    };
    add("xp-lg xp-lg-off", "", "not running");
    add("xp-lg xp-lg-ready", "", "open, waiting");
    add("xp-lg xp-lg-working", "", "working now");
    add("xp-lg-need blocked", "!", "blocked: can't progress, act now");
    add("xp-lg-need pending", "\u2026", "pending: queued, still working");
    add("xp-lg-need stopped", "\u25CB", "stopped: nobody blocked it, look");
    list.parentNode.insertBefore(legend, list.nextSibling);
  }

  window.xpApplyAgentStates = () => { try { applyAgentStates(); } catch (e) { /* cosmetic */ } };

  async function refresh() {
    try {
      overview = await window.api.getAgentOverview();
    } catch (e) {
      console.error("[header-tasks] overview", e);
      return;
    }
    applyAgentStates();
    updateCount();
    render();
  }

  let lastActive = null;
  function apply() {
    try { buildHeader(); } catch (e) { console.error("[header-tasks] header", e); }
    try { buildPanel(); } catch (e) { console.error("[header-tasks] panel", e); }
    try { applyAgentStates(); } catch (e) { console.error("[header-tasks] states", e); }
    try { buildLegend(); } catch (e) { console.error("[header-tasks] legend", e); }
    // Agent switch: re-render from the data already in hand, no extra IPC.
    const cur = typeof activeAgentPath === "undefined" ? null : activeAgentPath;
    if (cur !== lastActive) { lastActive = cur; updateCount(); render(); }
  }

  // The chat header and the sidebar are rebuilt on agent selection and every
  // list refresh, so re-apply rather than assuming a single pass is enough.
  // Guarded against re-entry: render() itself mutates the DOM this observes.
  // v1.68.0: was document.body + subtree, i.e. apply() (four builders and a querySelectorAll over every sidebar
  // row) ran after ANY mutation anywhere - every chat re-render, every 1 Hz indicator tick. Now only the two places
  // it manages are watched (sidebar, chat header), one apply per animation frame, and the records caused by apply()
  // itself are discarded instead of re-triggering it.
  let applying = false, applyQueued = false;
  apply();
  const mo = new MutationObserver(() => {
    if (applying || applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(() => {
      applyQueued = false;
      applying = true;
      try { apply(); } finally { applying = false; mo.takeRecords(); }
    });
  });
  for (const id of ["sidebar", "chat-header"]) {
    const el = document.getElementById(id);
    if (el) mo.observe(el, { childList: true, subtree: true });
  }
  refresh();
  setInterval(refresh, POLL_MS);
})();

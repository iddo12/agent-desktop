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
    { label: "Chat", btn: null },                       // the default view
    { label: "Terminal", btn: "raw-terminal-toggle-btn" },
    { label: "Chats", btn: "chats-toggle-btn" },
    { label: "History", btn: "history-toggle-btn" },
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

  function buildHeader() {
    const header = $("chat-header");
    if (!header || header.dataset.xpDone) return;

    // The five status readings go in their own box that is allowed to clip.
    // Without this the header overflowed at 1266px wide and pushed the Session
    // menu clean off the right edge - present in the DOM, unreachable on
    // screen, which is how Iddo noticed buttons were "missing". Status is the
    // right thing to sacrifice when space runs out; controls are not.
    const status = document.createElement("div");
    status.className = "xp-status";
    ["five-hour-usage", "weekly-usage", "monthly-usage", "context-usage", "cache-status"].forEach((id) => {
      const el = $(id);
      if (el) status.appendChild(el);
    });
    header.appendChild(status);

    const controls = document.createElement("div");
    controls.className = "xp-controls";

    // Segmented view switcher.
    const seg = document.createElement("div");
    seg.className = "xp-seg";
    VIEWS.forEach((v, i) => {
      const b = document.createElement("button");
      b.className = "xp-seg-btn" + (i === 0 ? " active" : "");
      b.textContent = v.label;
      b.addEventListener("click", () => {
        seg.querySelectorAll(".xp-seg-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
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
    // Built from nodes rather than innerHTML throughout this file: the task
    // text these controls will eventually carry comes from dictated voice
    // notes and from other agents, i.e. not content this code authored.
    tasksBtn.append("Tasks ");
    const count = document.createElement("span");
    count.className = "xp-count";
    count.textContent = "0";
    tasksBtn.appendChild(count);
    tasksBtn.addEventListener("click", () => document.body.classList.toggle("xp-panel-open"));
    controls.appendChild(tasksBtn);

    // One menu for everything that changes or ends the session.
    const wrap = document.createElement("div");
    wrap.className = "xp-menu-wrap";
    const menuBtn = document.createElement("button");
    menuBtn.className = "xp-menu-btn";
    menuBtn.textContent = "Session ▾";
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
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
    document.addEventListener("click", () => menu.classList.remove("open"));
    wrap.appendChild(menuBtn);
    wrap.appendChild(menu);
    controls.appendChild(wrap);

    header.appendChild(controls);
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
  // Packaged-install feature probe (v1.56.0): a clean install has no
  // Telegram bridge task queue, so the "From Telegram" section (and its
  // approve buttons) is hidden rather than shown as permanently empty.
  // Defaults true so nothing changes before the probe resolves or on
  // Iddo's own machine, where it always resolves true anyway.
  let telegramFeature = true;
  window.api.getFeatures().then((f) => {
    if (f && f.telegram === false) { telegramFeature = false; render(); }
  }).catch(() => {});

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
      if (telegramFeature) {
        const pending = a.telegram.filter((t) => t.status === "pending").map((t) => ({ text: t.body, taskId: t.id }));
        const approved = a.telegram.filter((t) => t.status === "approved").map((t) => ({ text: "Approved: " + t.body }));
        body.appendChild(section("From Telegram", "Dictated while away - not acted on until you approve.",
          pending.concat(approved), { approvable: true, empty: "No Telegram tasks for this agent." }));
      }
      body.appendChild(section("Agreed with this agent",
        a.openFile ? `This agent's OPEN NOW list (${a.openFile}).` : "This agent keeps no OPEN NOW list yet.",
        a.openItems.map((t) => ({ text: t })), { empty: "Its OPEN NOW list is empty." }));
    } else {
      const waiting = [];
      if (telegramFeature) {
        overview.unassigned.forEach((t) => waiting.push({ text: "Unassigned - " + t.body }));
        overview.agents.forEach((a) => a.telegram.filter((t) => t.status === "pending")
          .forEach((t) => waiting.push({ text: `${a.displayName} - approve: ${t.body}`, taskId: t.id })));
      }
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
    const pendingTelegram = (agent) => telegramFeature ? agent.telegram.filter((t) => t.status === "pending").length : 0;
    count.textContent = String(a ? a.openItems.length + pendingTelegram(a) : 0);
    const waiting = overview ? (telegramFeature ? overview.unassigned.length : 0) +
      overview.agents.reduce((s, x) => s + pendingTelegram(x), 0) : 0;
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
  function applyAgentStates() {
    if (!overview) return;
    const byFolder = new Map(overview.agents.map((a) => [a.folderName, a]));
    document.querySelectorAll("#agent-list .agent-item").forEach((row) => {
      const a = byFolder.get(row.dataset.folderName);
      const state = a ? a.state : "idle";
      if (row.dataset.xpState === state) return;
      row.dataset.xpState = state;
      row.classList.remove("xp-working", "xp-ready", "xp-idle");
      row.classList.add("xp-" + state);
    });
  }

  function buildLegend() {
    const list = document.getElementById("agent-list");
    if (!list || document.querySelector(".xp-legend")) return;
    const legend = document.createElement("div");
    legend.className = "xp-legend";
    legend.title = "Avatar ring = session state. The small dot is the agent's own health reading, a separate thing.";
    [["working", "working now"], ["ready", "open, waiting"], ["idle", "not running"]].forEach(([k, label]) => {
      const item = document.createElement("span");
      const sw = document.createElement("i");
      sw.className = "xp-sw xp-sw-" + k;
      item.appendChild(sw);
      item.append(label);
      legend.appendChild(item);
    });
    list.parentNode.insertBefore(legend, list.nextSibling);
  }

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
  let applying = false;
  apply();
  const mo = new MutationObserver(() => {
    if (applying) return;
    applying = true;
    try { apply(); } finally { applying = false; }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  refresh();
  setInterval(refresh, POLL_MS);
})();

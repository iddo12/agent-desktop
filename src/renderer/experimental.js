// Sandbox-only UI proposals. Injected by main.js ONLY when TEST_MODE is set,
// so Iddo can look at a redesign before any of it reaches the app he works in.
// The live app never loads this file.
//
// SAFETY RULE FOR EVERYTHING IN HERE: never re-implement behaviour. The
// original controls stay in the DOM, hidden, and every new control forwards
// its click to the real button via .click(). That way a proposal cannot break
// a working feature - at worst it looks wrong - and throwing the proposal away
// is deleting one file rather than unpicking a refactor.
//
// Two proposals currently live:
//   1. The header, restructured. Iddo: "square and round buttons next to each
//      other with different strange spacing - it just doesn't look like a
//      proper UI." Styling alone (styles-experimental.css) fixed the mismatch
//      but the row still wrapped onto two lines, because ten peer buttons is
//      ten peer buttons. This groups them by what they actually are.
//   2. The task panel he asked for: a right-side slide-out showing that
//      agent's open work as two stacked sets - Telegram tasks awaiting his
//      approval, and tasks agreed with the agent or sent by other agents.

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
    count.textContent = "3";
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
  // Sample rows, clearly labelled as such. The point of the demo is the shape -
  // two stacked sets, one short line each - not the data. Real wiring reads
  // the Telegram task store and each agent's own open-items list.
  const TELEGRAM_TASKS = [
    "Chase Cartoni about the heavy-duty arm",
    "Add Malcolm's new email to the rolodex",
    "Re-cut the intro on the Nanlite video",
  ];
  // The all-agents view is deliberately NOT "every task concatenated" - the
  // per-agent view already answers "what is this agent doing". Across agents
  // the question is triage, so it leads with what is waiting on Iddo, then
  // what needs attention (the overnight case: two agents sat halted on a 500
  // and nothing surfaced it), then a collapsed count per agent.
  const GLOBAL_WAITING = [
    "Trade Show Agent - approve: add Malcolm's new email",
    "Product Development - approve: chase Cartoni about the arm",
    "Unassigned - re-cut the intro on the Nanlite video",
  ];
  const GLOBAL_ATTENTION = [
    "Trade Show Agent - halted on an API error 67 min ago",
    "Product Development - 174K context, needs a handoff",
  ];
  const GLOBAL_INFLIGHT = [
    "Security - 6 open",
    "Trade Show Agent (IBC) - 4 open",
    "Product Development Agent - 4 open",
    "Agent Desktop backlog - 3 open",
  ];

  const AGENT_TASKS = [
    "Finish the ExoCam concept brief and rebuild the PDF",
    "Check whether a phone rig can give mm-level measurements",
    "Send the exoskeleton company list to Malcolm",
    "Decide the title: Concept Brief vs Concept Proposal",
  ];

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

    const section = (title, note, items, withChecks) => {
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
      const ul = document.createElement("ul");
      ul.className = "xp-list";
      items.forEach((t) => {
        const li = document.createElement("li");
        if (withChecks) {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          li.appendChild(cb);
        }
        const span = document.createElement("span");
        span.textContent = t;
        li.appendChild(span);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      if (withChecks) {
        const row = document.createElement("div");
        row.className = "xp-actions";
        ["Approve selected", "Approve all"].forEach((label, i) => {
          const b = document.createElement("button");
          b.className = i === 0 ? "xp-approve" : "xp-approve-all";
          b.textContent = label;
          row.appendChild(b);
        });
        sec.appendChild(row);
      }
      return sec;
    };

    // Scope switch. Same panel, same components - the global view is the
    // per-agent one with the filter removed and grouping added, which is why
    // it was worth designing in now rather than retrofitting.
    const scope = document.createElement("div");
    scope.className = "xp-scope";
    const body = document.createElement("div");
    body.className = "xp-body";

    const renderScope = (which) => {
      body.textContent = "";
      if (which === "agent") {
        body.appendChild(section("From Telegram", "Dictated while away - not acted on until you approve.", TELEGRAM_TASKS, true));
        body.appendChild(section("Agreed with this agent", "Already agreed, or sent by another agent.", AGENT_TASKS, false));
      } else {
        body.appendChild(section("Waiting on you", "Approvals and unplaced tasks, across every agent.", GLOBAL_WAITING, true));
        body.appendChild(section("Needs attention", "Halted, stuck, or out of room - nothing else surfaces these.", GLOBAL_ATTENTION, false));
        body.appendChild(section("In flight", "Open work per agent.", GLOBAL_INFLIGHT, false));
      }
      const foot = document.createElement("p");
      foot.className = "xp-foot";
      foot.textContent = "Sample data - this is a layout demo running only in the sandbox.";
      body.appendChild(foot);
    };

    [["This agent", "agent"], ["All agents", "global"]].forEach(([label, key], i) => {
      const b = document.createElement("button");
      b.className = "xp-scope-btn" + (i === 0 ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        scope.querySelectorAll(".xp-scope-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        renderScope(key);
      });
      scope.appendChild(b);
    });

    panel.appendChild(scope);
    panel.appendChild(body);
    renderScope("agent");

    document.body.appendChild(panel);
  }

  function apply() {
    try { buildHeader(); } catch (e) { console.error("[experimental] header", e); }
    try { buildPanel(); } catch (e) { console.error("[experimental] panel", e); }
  }

  // The chat header is rebuilt when an agent is selected, so re-apply rather
  // than assuming a single pass is enough.
  apply();
  const mo = new MutationObserver(() => apply());
  mo.observe(document.body, { childList: true, subtree: true });
})();

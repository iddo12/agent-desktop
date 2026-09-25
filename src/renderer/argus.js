// ARGUS - the Bridge (v1.39.0). One screen for every agent's report, the
// Decision Queue (everything waiting on Iddo) and the weekly ideas board.
//
// Iddo, 2026-09-22: inside Agent Desktop, but "it will need as much
// monitor/screen real estate as possible ... when we open it it will take most
// of the screen and shrink the rest of the Agent Desktop significantly" (he
// works on a 32" monitor), while other users with small monitors (Merav) must
// still be able to use it. So: opening Argus collapses the sidebar to a strip
// of avatars, and the layout goes from three columns to two to one as the
// window narrows.
//
// Display rules (cockpit / control-room practice; the full, cited set is in
// the strategy document):
//   - quiet when normal: grey by default, colour only for deviations
//   - one alert hierarchy everywhere: warning (red) > caution (amber) >
//     advisory (cyan); a master lamp at the top carries the counts
//   - every number beside its previous value, with a direction
//   - glance (lamps + number strip) -> scan (lists) -> dig (click to expand,
//     then the full report or the agent's chat)
//   - a problem reported by two agents is shown once, naming both
//   - things no agent scores (accepted risks, sites frozen for rebuild) are
//     kept, but in a collapsed "tracked" group
//
// Built outside renderer.js, like header-tasks.js and library.js: it only
// adds its own elements, reads data through window.api, and forwards to
// existing controls. Every string comes from agent-written files, so all text
// goes in through textContent.

(() => {
  "use strict";

  const REFRESH_MS = 10 * 60 * 1000;
  const BADGE_MS = 60 * 1000;
  const ORDER = { warning: 0, caution: 1, advisory: 2 };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const shortAgent = (a) => (a || "").startsWith("System Optimization") ? "Optimization"
    : a === "LensVid_Master_Context" ? "LensVid context" : (a || "").replace(/ Agent( \(IBC\))?$/, "");

  let data = null;
  let loading = false;
  // Live per-agent state for the "Agents" tile; see fleetAgentStates().
  let agentStates = [];
  let refreshTimer = null;

  // ---------------------------------------------------------------- sidebar
  const nav = el("button", "argus-nav");
  nav.title = "Argus - the Bridge: every agent's report, what needs you, and this week's ideas";
  const navName = el("span", "argus-nav-name");
  navName.append(el("span", "argus-nav-title", "ARGUS"), el("span", "argus-nav-sub", "The Bridge"));
  const navLamps = el("span", "argus-nav-lamps");
  nav.append(navName, navLamps);
  nav.addEventListener("click", () => openArgus());
  const agentList = document.getElementById("agent-list");
  const libNav = document.getElementById("library-nav");
  agentList.parentNode.insertBefore(nav, libNav || agentList);

  // Packaged-install feature probe (v1.59.0): a clean install has no
  // shared_reports for ARGUS to show, so hide the tab entirely rather than
  // opening onto an empty control room. Always true today for Iddo's own
  // workspace, so this never hides anything for him.
  window.api.getFeatures().then((f) => {
    if (f && f.argus === false) nav.classList.add("hidden");
  }).catch(() => {});

  // ---------------------------------------------------------------- view
  const view = el("div");
  view.id = "argus-view";
  view.className = "hidden";
  document.getElementById("main-panel").appendChild(view);

  const head = el("div", "argus-head");
  const title = el("div", "argus-title");
  title.append(el("span", "argus-title-main", "ARGUS"), el("span", "argus-title-sub", "The Bridge"));
  const stamp = el("span", "argus-stamp");
  const lamps = el("div", "argus-lamps");
  const lampW = el("span", "argus-lamp warn clickable", "WARNING");
  const lampC = el("span", "argus-lamp caut clickable", "CAUTION");
  const lampD = el("span", "argus-lamp dec clickable", "NEEDS YOU");
  // Fourth lamp, and the only one that is not an alarm: how many agents exist
  // and how many are working right now. Iddo, 2026-09-23, pointing at this row:
  // "I asked that you add the number of agents and active agents with a link to
  // a list here". v1.48.0 had put it in the number strip below instead; the
  // strip scrolls and the lamps do not, and this is a fleet-wide fact he wants
  // at a glance, so it belongs up here. Same click target as the strip tile -
  // both open the roster panel.
  const lampA = el("span", "argus-lamp agents clickable hidden", "AGENTS");
  lamps.append(lampW, lampC, lampD, lampA);
  const refreshBtn = el("button", "argus-btn", "Refresh");
  refreshBtn.addEventListener("click", () => load(true));
  const closeBtn = el("button", "argus-close", "×");
  closeBtn.title = "Back to the agents (Esc)";
  closeBtn.addEventListener("click", closeArgus);
  head.append(title, stamp, lamps, refreshBtn, closeBtn);

  const strip = el("div", "argus-strip");
  const grid = el("div", "argus-grid");
  const colA = el("div", "argus-col");
  const colB = el("div", "argus-col");
  const colC = el("div", "argus-col");
  grid.append(colA, colB, colC);
  const scroller = el("div", "argus-scroll");
  scroller.append(strip, grid);
  view.append(head, scroller);

  function openArgus(focus) {
    document.body.classList.add("argus-open");
    // The sidebar carries its own remembered width in this mode (renderer.js,
    // ARGUS_SIDEBAR_* - user-draggable since v1.47.0, previously a hard 78px).
    // Apply it on the mode change rather than on the next drag, or the Bridge
    // opens at whatever width the chat sidebar happened to be at.
    window.applySidebarWidth?.();
    view.classList.remove("hidden");
    nav.classList.add("active");
    // The Library, if open, steps aside (it has its own close).
    const lib = document.getElementById("library-view");
    if (lib && !lib.classList.contains("hidden")) document.querySelector("#library-view .library-close")?.click();
    load(true).then(() => {
      if (focus === "decisions") document.getElementById("argus-decisions")?.scrollIntoView({ block: "start" });
    });
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => load(true), REFRESH_MS);
  }
  function closeArgus() {
    document.body.classList.remove("argus-open");
    document.body.classList.remove("argus-sidebar-wide");
    window.applySidebarWidth?.();
    view.classList.add("hidden");
    nav.classList.remove("active");
    clearInterval(refreshTimer);
  }
  agentList.addEventListener("click", (e) => { if (e.target.closest(".agent-item")) closeArgus(); }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("argus-open")) closeArgus();
  });

  // ---------------------------------------------------------------- helpers
  function delta(v, p, better) {
    const s = el("span", "argus-cmp");
    if (p == null || v == null) { s.textContent = "(no earlier figure)"; return s; }
    s.textContent = "(" + p + ")";
    const d = typeof v === "number" && typeof p === "number" ? Math.round((v - p) * 10) / 10 : 0;
    if (d && better !== "none") {
      // Direction by arrow, not colour: red and amber mean warning and caution
      // here and nothing else (FAA 25.1322(f) - non-alert use of the alert
      // colours blunts them). A better/worse hint rides on the arrow's title.
      const good = better === "up" ? d > 0 : d < 0;
      const arrow = el("span", "argus-delta", " " + (d > 0 ? "▲" : "▼") + Math.abs(d));
      arrow.title = good ? "better than last time" : "worse than last time";
      s.appendChild(arrow);
    }
    return s;
  }
  // `subText` replaces the comparison line for a figure that has no meaningful
  // previous value to be compared against - the agent roster is a composition,
  // not a measurement, so "(no earlier figure)" under it would be noise where
  // the breakdown it is made of is the useful thing. Every other tile still
  // carries its comparison, per the workspace rule.
  function kpi(label, val, prev, better, bad, unit, onClick, subText) {
    const k = el("div", "argus-kpi" + (bad ? " bad" : "") + (onClick ? " clickable" : ""));
    k.appendChild(el("div", "argus-kpi-label", label));
    k.appendChild(el("div", "argus-kpi-val", (val == null ? "–" : val) + (unit || "")));
    k.appendChild(subText ? el("span", "argus-cmp", subText) : delta(val, prev, better));
    if (onClick) k.addEventListener("click", onClick);
    strip.appendChild(k);
  }
  function card(host, heading, id, onClick) {
    const c = el("section", "argus-card");
    if (id) c.id = id;
    const h = el("h2", "argus-card-head" + (onClick ? " clickable" : ""), heading);
    if (onClick) h.addEventListener("click", onClick);
    c.appendChild(h);
    host.appendChild(c);
    return c;
  }
  // A parked finding is no longer an alarm. It stays in the lists that account
  // for everything - the agent's own findings, the tracked group - because it
  // has not gone away, but it must not wear WARNING red there. Iddo, 2026-09-23,
  // pointing at the NAS disk still in red inside the Security score panel after
  // he had parked it: "still here as well". Parked comes from the fleet-wide
  // shared_reports/accepted_risks.json, applied by build_status.py to every
  // agent that reports the same thing.
  const alertClass = (a) => a.accepted ? "argus-item alert parked" : "argus-item alert " + a.level;
  const alertLvl = (a) => a.accepted ? "PARKED" : (a.level || "").toUpperCase();
  const parkedLine = (a, host) => {
    if (!a.accepted) return;
    const who = a.acceptedBy ? " by " + a.acceptedBy : "";
    host.appendChild(el("div", "argus-item-meta argus-parked-note",
      "Parked" + who + (a.acceptedOn ? " on " + a.acceptedOn : "") +
      " - not counted, and not shown as needing action." + (a.acceptedNote ? " " + a.acceptedNote : "")));
  };

  function dedupeKey(t) {
    return (t || "").toLowerCase().replace(/\d+([.,]\d+)?/g, "").replace(/[^a-z]+/g, " ")
      .split(" ").filter((w) => w.length > 3).sort().filter((w, i, a) => a.indexOf(w) === i).join(" ");
  }

  // ------------------------------------------------------- the agent roster
  // Iddo, 2026-09-23, pointing at the gap in the number strip: "I would put
  // here the total number of agents with the running in parenthesis or
  // something similar and when pressing it you get the full list of which
  // agent is running, idle etc."
  //
  // Deliberately NOT read from the Bridge's own status files: those are built
  // from each agent's last written report and say what an agent reported, not
  // whether it is doing something right now. "Running" here is the same
  // evidence the chat view trusts - the agent's own transcript. `working` is
  // an assistant tool_use with no result yet; the transcript's quiet time says
  // how long since it last wrote anything, which is what makes "idle" mean
  // something rather than just "not working this instant".
  const AGENT_STATES = ["running", "idle", "paused", "unknown"];
  async function fleetAgentStates() {
    let list = [];
    try {
      list = (await window.api.listAgents()) || [];
    } catch (e) {
      return [];
    }
    return Promise.all(
      list.map(async (a) => {
        const row = {
          folder: a.folderName,
          name: a.displayName || a.folderName,
          role: a.role || "",
          // The agent's own current-work line from its master_state - the
          // closest thing to "what is it doing" that costs nothing to read.
          status: a.status || "",
          avatar: a.avatar || "",
          health: a.healthLabel || "Unknown",
          paused: !!a.paused,
          working: null,
          workingMs: null,
          quietMs: null,
        };
        if (!row.paused) {
          try {
            const act = await window.api.getSessionActivity(a.path);
            row.working = act ? !!act.working : null;
            row.workingMs = act && act.working ? act.sinceMs : null;
          } catch (e) { /* no transcript yet - stays unknown */ }
          try {
            row.quietMs = await window.api.getTranscriptQuietMs(a.path);
          } catch (e) { /* same */ }
        }
        row.state = row.paused ? "paused" : row.working === true ? "running" : row.working === false ? "idle" : "unknown";
        return row;
      })
    );
  }

  function agoText(ms) {
    if (ms == null) return "never written to";
    const m = Math.round(ms / 60000);
    if (m < 1) return "active seconds ago";
    if (m < 60) return `last active ${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `last active ${h} h ago`;
    return `last active ${Math.round(h / 24)} d ago`;
  }

  function agentsDetail(rows) {
    // Rebuilt 2026-09-23 after Iddo saw the first version - built out of the
    // generic label/value lines this panel uses everywhere else - and said:
    // "this cuts off and this pane looks bad in general I wanted a nice
    // graphical list with a row for each agent and thumbnail maybe info on
    // what its status is in color or even what its doing something of that
    // sort". A label/value row gives the name a narrow fixed column, so every
    // multi-word agent name broke one word per line and the role ran off the
    // right edge. This is a purpose-built row instead: the agent's own avatar,
    // its name on one line with a coloured state pill, its own current-work
    // line beneath, and the timing on the right. The state groups are gone -
    // the colour carries that now, and running agents simply sort first.
    const ORDER_STATE = { running: 0, idle: 1, paused: 2, unknown: 3 };
    const stateWord = { running: "RUNNING", idle: "IDLE", paused: "PAUSED", unknown: "NO TRANSCRIPT" };
    return (host) => {
      if (!rows.length) {
        dText(host, "No agents could be listed - the agent folder could not be read.");
        return;
      }
      const running = rows.filter((r) => r.state === "running").length;
      dText(host, `${rows.length} agents, ${running} working right now. Live state, read from each agent's own transcript rather than from its last report - "running" means it has a tool call in flight, "idle" means its process is there and waiting. Click a row to open that agent's chat.`);
      const list = el("div", "argus-roster");
      [...rows].sort((a, b) => (ORDER_STATE[a.state] - ORDER_STATE[b.state]) || a.name.localeCompare(b.name))
        .forEach((r) => {
          const row = el("div", "argus-roster-row " + r.state);
          row.title = "Open " + r.name + "'s chat";
          if (r.avatar) {
            const img = el("img", "argus-roster-av");
            img.src = r.avatar;
            img.alt = "";
            row.appendChild(img);
          } else {
            row.appendChild(el("div", "argus-roster-av argus-roster-av-none",
              r.name.replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("")));
          }
          const main = el("div", "argus-roster-main");
          const nameRow = el("div", "argus-roster-name");
          nameRow.append(el("span", "argus-roster-nametext", r.name),
            el("span", "argus-roster-pill " + r.state, stateWord[r.state] || r.state.toUpperCase()));
          if (r.health && r.health !== "Healthy" && r.health !== "Unknown") {
            nameRow.appendChild(el("span", "argus-roster-pill health", r.health));
          }
          main.appendChild(nameRow);
          // What it is doing, in its own words where it has them. The status
          // comes straight out of master_state.md, so it arrives with markdown
          // bold markers and often a leading date - both are noise here. And
          // where an agent has no real status yet ("No work plan yet"), its
          // role says more than a placeholder does.
          const clean = String(r.status || "").replace(/\*\*/g, "").replace(/^[*\s]+/, "")
            .replace(/^\d{4}-\d{2}-\d{2}\s*[:–-]\s*/, "").trim();
          const isPlaceholder = /^(no work plan|no status|not set|none)\b/i.test(clean);
          // One agent's status block is 26,000 characters of accumulated
          // history; only the first sentence belongs in a one-line row.
          const short = clean.length > 180 ? clean.slice(0, 180).replace(/\s+\S*$/, "") + "..." : clean;
          const chosen = !clean || isPlaceholder ? (r.role || short) : short;
          // Stripping a leading date often leaves the sentence starting
          // lower-case ("created, and its first brief has run").
          const line = r.state === "paused" ? "Paused - it has no background process running."
            : chosen ? chosen.charAt(0).toUpperCase() + chosen.slice(1) : "";
          if (line) main.appendChild(el("div", "argus-roster-doing", line));
          row.appendChild(main);
          const when = el("div", "argus-roster-when");
          when.appendChild(el("div", "", r.state === "running" && r.workingMs != null
            ? "working " + (r.workingMs < 60000 ? Math.max(1, Math.round(r.workingMs / 1000)) + " s"
              : Math.round(r.workingMs / 60000) + " min")
            : r.state === "paused" ? "paused"
            : r.state === "unknown" ? "never written to"
            : agoText(r.quietMs).replace(/^last active /, "")));
          row.appendChild(when);
          row.addEventListener("click", () => openAgent(r.folder));
          list.appendChild(row);
        });
      host.appendChild(list);
    };
  }

  // Open an agent's chat without putting words in the box, unlike discuss().
  function openAgent(agentFolder) {
    closeArgus();
    const row = document.querySelector(`#agent-list .agent-item[data-folder-name="${CSS.escape(agentFolder)}"]`);
    if (row) row.click();
  }

  // Jump to an agent's chat with a starter line - answering a decision is a
  // conversation with the agent that owns it.
  function discuss(agentFolder, text) {
    closeArgus();
    const row = document.querySelector(`#agent-list .agent-item[data-folder-name="${CSS.escape(agentFolder)}"]`);
    if (row) row.click();
    setTimeout(() => {
      const box = document.getElementById("chat-input");
      if (!box) return;
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 400);
  }

  // ---------------------------------------------------------------- drill-down
  // Iddo, 2026-09-23, after living with the Bridge: "most of the info is not
  // clickable... wasn't the whole idea that almost all the info points click
  // to present more information on that specific topic?" It was, and only the
  // lists had it. A number you cannot interrogate is a number you end up
  // taking on trust, which is the opposite of the point.
  //
  // So: one detail panel, opened from anywhere, built from data already in
  // hand. It never invents content - if a figure has no detail behind it, the
  // panel says where the figure came from and what would have to exist for
  // there to be more.
  const detail = el("div", "argus-detail hidden");
  const detailHead = el("div", "argus-detail-head");
  const detailTitle = el("h2", "argus-detail-title");
  const detailClose = el("button", "argus-close", "×");
  detailClose.title = "Close (Esc)";
  detailClose.addEventListener("click", closeDetail);
  detailHead.append(detailTitle, detailClose);
  const detailBody = el("div", "argus-detail-body");
  detail.append(detailHead, detailBody);
  view.appendChild(detail);

  function closeDetail() {
    detail.classList.add("hidden");
    document.body.classList.remove("argus-detail-open");
  }
  function openDetail(title, build) {
    detailTitle.textContent = title;
    detailBody.textContent = "";
    build(detailBody);
    detail.classList.remove("hidden");
    document.body.classList.add("argus-detail-open");
    detail.scrollTop = 0;
  }
  // Esc closes the panel first, and only then Argus itself.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !detail.classList.contains("hidden")) {
      e.stopImmediatePropagation();
      closeDetail();
    }
  }, true);

  // Small builders for the panel's own content.
  const dSection = (host, heading) => { host.appendChild(el("div", "argus-group", heading)); };
  const dLine = (host, label, value, onClick) => {
    const r = el("div", "argus-row" + (onClick ? " clickable" : ""));
    r.appendChild(el("span", "", label));
    r.appendChild(el("span", "argus-row-val", value == null || value === "" ? "–" : String(value)));
    if (onClick) r.addEventListener("click", onClick);
    host.appendChild(r);
  };
  // Clicking a figure inside the panel jumps to the list that explains it and
  // flashes it, so the answer is never "the number is right there and nothing
  // happens" (Iddo, 2026-09-23).
  function jumpTo(headingText) {
    return () => {
      const target = [...detailBody.querySelectorAll(".argus-group")]
        .find((g) => g.textContent.toLowerCase().startsWith(String(headingText).toLowerCase()));
      if (!target) return;
      target.scrollIntoView({ block: "start", behavior: "smooth" });
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 1200);
    };
  }
  const dText = (host, text) => { if (text) host.appendChild(el("p", "argus-detail-text", text)); };
  const dActions = (host, agentFolder, links, starter) => {
    const bar = el("div", "argus-detail-actions");
    if (links && links.report) {
      const b = el("button", "argus-btn primary", "Open the full report");
      b.addEventListener("click", () => openSourceFile(links.report, b));
      bar.appendChild(b);
    }
    if (links && links.openItems) {
      const b = el("button", "argus-btn", "Open its task list");
      b.addEventListener("click", () => openSourceFile(links.openItems, b));
      bar.appendChild(b);
    }
    if (agentFolder) {
      const b = el("button", "argus-btn", "Discuss with " + shortAgent(agentFolder));
      b.addEventListener("click", () => { closeDetail(); discuss(agentFolder, starter || ""); });
      bar.appendChild(b);
    }
    if (bar.children.length) host.appendChild(bar);
  };
  function openSourceFile(file, btn) {
    const was = btn.textContent;
    window.api.argusOpenSource(file).then((r) => {
      if (r && r.ok) return;
      btn.textContent = (r && r.error) || "Could not open it";
      setTimeout(() => { btn.textContent = was; }, 3000);
    });
  }

  // An agent's whole picture: score, every metric, every finding it raised.
  function agentDetail(a) {
    return (host) => {
      dLine(host, "Report date", a.reportDate || "unknown");
      dLine(host, "Built from", a.source || "—");
      if (a.score) {
        dSection(host, "Score");
        dLine(host, "Now", a.score.value + (a.score.label ? " · " + a.score.label : ""));
        dLine(host, "Previously", a.score.prev == null ? "no earlier figure"
          : a.score.prev + (a.score.prevDate ? " (" + a.score.prevDate + ")" : ""));
      }
      if ((a.metrics || []).length) {
        dSection(host, "Every measurement");
        a.metrics.forEach((m) => dLine(host, m.label,
          (m.value == null ? "–" : m.value) + (m.unit || "") +
          (m.prev == null ? "  (no earlier figure)" : "  (was " + m.prev + ")"),
          () => openDetail(m.label + " — " + shortAgent(a.agent), metricDetail(a, m))));
      }
      // What this agent carries before it starts work (2026-09-23).
      if (a.context) {
        const c = a.context, p = c.prev || {};
        dSection(host, "Memory and starting context" + (c.red ? " · over a limit" : ""));
        const line = (label, v, pv, unit, fmt) => {
          const r = el("div", "argus-row");
          r.appendChild(el("span", "", label));
          const val = el("span", "argus-row-val");
          val.appendChild(withPrev(v, pv, unit, fmt));
          r.appendChild(val);
          host.appendChild(r);
        };
        line("Starting context", c.startContextTokens, p.startContextTokens, "tokens", tokens);
        line("Memory total", c.memoryKB, p.memoryKB, "KB");
        line("Memory index", c.indexChars, p.indexChars, "chars");
        line("Pinned", c.pinnedKB, p.pinnedKB, "KB");
        line("Memory files", c.memoryFiles, p.memoryFiles, "");
        (c.redReasons || []).forEach((why) => dText(host, why));
        if (c.startContextBasis) dText(host, "Starting context measured over " + c.startContextBasis + ".");
      }
      const alerts = a.alerts || [];
      if (alerts.length) {
        dSection(host, `Findings it raised · ${alerts.length}`);
        alerts.forEach((al) => {
          const r = el("div", alertClass(al));
          const t = el("div", "argus-item-title");
          t.appendChild(el("span", "argus-lvl", alertLvl(al)));
          t.append(al.title);
          r.appendChild(t);
          if (al.why) r.appendChild(el("div", "argus-detail-text", al.why));
          if (al.action) r.appendChild(el("div", "argus-detail-text", "Do: " + al.action));
          const bits = [];
          if (al.firstSeen) bits.push("first seen " + al.firstSeen);
          if (al.ageDays >= 1) bits.push("standing " + al.ageDays + (al.ageDays === 1 ? " day" : " days"));
          if (al.accepted) bits.push("parked" + (al.acceptedOn ? " on " + al.acceptedOn : "") + " - not counted, and not shown as needing action");
          else if (!al.scored) bits.push("not scored - tracked, not counted against the score");
          if (bits.length) r.appendChild(el("div", "argus-item-meta", bits.join(" · ")));
          parkedLine(al, r);
          addDiscuss(r, a.agent, `About the "${al.title}" finding: `);
          host.appendChild(r);
        });
      } else {
        dText(host, "This agent raised no findings in its latest report.");
      }
      const open = a.openItems || [];
      if (open.length) {
        dSection(host, `On its open list · ${open.length}`);
        openItemRows(host, open, null, a.agent);
      }
      dActions(host, a.agent, a.links, "About your latest report: ");
    };
  }

  // Iddo, 2026-09-23: "make sure that I will always have an option to talk to
  // the relevant agent right from the info screen about any point - this is so
  // useful." So every row that can be attributed to an agent carries its own
  // way into that agent's chat, with a starter line naming the thing clicked,
  // rather than only the panel-level button at the bottom.
  // An idea that came out of research carries where it came from, and those
  // links open in the real browser rather than inside the app.
  function sourceLinks(host, sources) {
    if (!Array.isArray(sources) || !sources.length) return;
    const wrap = el("div", "argus-sources");
    wrap.appendChild(el("span", "argus-sources-label", "Sources:"));
    sources.slice(0, 6).forEach((sc) => {
      const url = typeof sc === "string" ? sc : sc.url;
      if (!url || !/^https?:\/\//i.test(url)) return;
      const a = el("a", "argus-source-link", (typeof sc === "object" && sc.title) || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 46));
      a.href = url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.title = url;
      a.addEventListener("click", (ev) => ev.stopPropagation());
      wrap.appendChild(a);
    });
    if (wrap.children.length > 1) host.appendChild(wrap);
  }

  function discussBtn(agentFolder, starter) {
    if (!agentFolder) return null;
    const b = el("button", "argus-btn discuss-inline", "Discuss with " + shortAgent(agentFolder));
    b.addEventListener("click", (ev) => { ev.stopPropagation(); closeDetail(); discuss(agentFolder, starter); });
    return b;
  }
  function addDiscuss(row, agentFolder, starter) {
    const b = discussBtn(agentFolder, starter);
    if (b) row.appendChild(b);
  }

  // Iddo's verdict on an idea. Three words, written straight back into the
  // agent's own recommendations file, because an agent told to keep only the
  // sources that keep being useful needs to know which of its ideas landed
  // (2026-09-23). Without this the research programme has no feedback at all.
  function verdictBar(item, week, agentFolder, onChange) {
    const bar = el("div", "argus-verdict");
    const current = (item.decision || {}).verdict || "none";
    const choices = [["approved", "Approve"], ["parked", "Park"], ["rejected", "Reject"]];
    const status = el("span", "argus-verdict-state");
    const paint = () => {
      const v = (item.decision || {}).verdict;
      status.textContent = v ? v.charAt(0).toUpperCase() + v.slice(1) +
        ((item.decision || {}).at ? " · " + new Date(item.decision.at).toLocaleDateString() : "") : "";
      [...bar.querySelectorAll("button")].forEach((b) => b.classList.toggle("on", b.dataset.verdict === v));
    };
    choices.forEach(([verdict, label]) => {
      const b = el("button", "argus-btn verdict", label);
      b.dataset.verdict = verdict;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const next = (item.decision || {}).verdict === verdict ? "none" : verdict;
        b.disabled = true;
        window.api.argusSetIdeaDecision({ week, agent: agentFolder, id: item.id, verdict: next }).then((r) => {
          b.disabled = false;
          if (!r || !r.ok) { status.textContent = (r && r.error) || "Could not save"; return; }
          item.decision = next === "none" ? undefined : { verdict: next, at: new Date().toISOString() };
          paint();
          if (onChange) onChange();
        });
      });
      bar.appendChild(b);
    });
    bar.appendChild(status);
    paint();
    return bar;
  }

  // Which agent owns a scheduled job. The task name prefix is the convention
  // (SEC_, OPT_, WEEKLY_Recs_, COO_), and an output's file path contains the
  // agent's own folder, which is the more reliable of the two.
  function agentForJob(name, file) {
    const folders = (data.agents || []).map((a) => a.agent);
    if (file) {
      const hit = folders.find((f) => String(file).toLowerCase().includes(f.toLowerCase()));
      if (hit) return hit;
    }
    const n = String(name || "");
    if (/^SEC_/i.test(n)) return folders.find((f) => f === "Security");
    if (/^OPT_/i.test(n)) return folders.find((f) => f.startsWith("System Optimization"));
    if (/^COO_/i.test(n)) return folders.find((f) => f === "COO Agent");
    // Fall back on the display name appearing in the job's own name, which is
    // how the weekly jobs and the human-readable output checks are labelled
    // ("WEEKLY_Recs_LensVidContext", "Security morning review (08:40)").
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z]/g, "");
    const weekly = n.match(/^WEEKLY_Recs_(.+)$/i);
    const needle = norm(weekly ? weekly[1] : n);
    const byShortName = folders.find((f) => {
      const short = norm(shortAgent(f));
      if (short.length <= 4) return false;
      // "WEEKLY_Recs_ProductDev" abbreviates the department, so a prefix match
      // in either direction counts for the weekly jobs; elsewhere require the
      // whole name, to avoid a stray substring claiming the wrong agent.
      return weekly ? (short.startsWith(needle) || needle.startsWith(short)) : needle.includes(short);
    });
    if (byShortName) return byShortName;
    return folders.find((f) => norm(f).length > 4 && needle.includes(norm(f))) || null;
  }

  // The items behind an "open items" / "needs you" / "blocked" count. A count
  // is a claim; this is the evidence for it.
  function openItemRows(host, items, note, agentFolder) {
    if (!items.length) { dText(host, note || "Nothing open."); return; }
    items.forEach((it) => {
      const r = el("div", "argus-item" + (it.needsIddo ? " decision" : ""));
      r.appendChild(el("div", "argus-item-title", it.title || "(untitled)"));
      const bits = [];
      if (it.needsIddo) bits.push("needs you");
      if (it.status && it.status !== "open") bits.push(it.status);
      if (it.priority === 1) bits.push("priority 1");
      if (it.group) bits.push(it.group);
      if (it.since) bits.push("since " + it.since);
      if (bits.length) r.appendChild(el("div", "argus-item-meta", bits.join(" · ")));
      if (it.detail) r.appendChild(el("div", "argus-detail-text", it.detail));
      addDiscuss(r, agentFolder, `About "${it.title}": `);
      host.appendChild(r);
    });
  }

  // The three list panels behind the lamps and the card headings.
  function alertsDetail(W, C, V, tracked) {
    return (host) => {
      const block = (heading, list, note) => {
        if (!list.length) return;
        dSection(host, `${heading} · ${list.length}`);
        if (note) dText(host, note);
        list.forEach((a) => {
          const r = el("div", alertClass(a));
          const t = el("div", "argus-item-title");
          t.appendChild(el("span", "argus-lvl", alertLvl(a)));
          t.append(a.title);
          r.appendChild(t);
          r.appendChild(el("div", "argus-item-meta", (a.agents || []).join(" + ") +
            (a.domain ? " · " + a.domain : "") +
            (a.firstSeen ? " · first seen " + a.firstSeen : "")));
          if (a.why) r.appendChild(el("div", "argus-detail-text", a.why));
          if (a.action) r.appendChild(el("div", "argus-detail-text", "Do: " + a.action));
          parkedLine(a, r);
          addDiscuss(r, a.folder, `About the "${a.title}" finding: `);
          host.appendChild(r);
        });
      };
      block("Warnings", W);
      block("Cautions", C);
      block("Advisories", V);
      block("Tracked", tracked, "Nothing here counts against any score: accepted risks, and sites frozen for rebuild. They stay visible so they are not forgotten.");
      if (!W.length && !C.length && !V.length && !tracked.length) dText(host, "No findings at all right now.");
    };
  }

  function decisionsDetail(D) {
    return (host) => {
      dText(host, /coo/i.test(data.decisionsBuiltBy || "")
        ? "Ranked and de-duplicated by the COO from every agent's open items."
        : "Collected from each agent's open items. The COO ranks this queue once it has run today.");
      if (!D.length) { dText(host, "Nothing is waiting on you."); return; }
      D.forEach((d, i) => {
        const r = el("div", "argus-item decision");
        r.appendChild(el("div", "argus-item-title", (d.rank ? d.rank + ". " : (i + 1) + ". ") + d.title));
        const bits = [shortAgent(d.agent) || "fleet-wide"];
        if (d.group) bits.push(d.group);
        if (d.blocked) bits.push("blocked");
        r.appendChild(el("div", "argus-item-meta", bits.join(" · ")));
        if (d.detail) r.appendChild(el("div", "argus-detail-text", d.detail));
        if (d.action) r.appendChild(el("div", "argus-detail-text", "→ " + d.action));
        if (d.agent) {
          const go = el("button", "argus-btn", "Discuss with " + shortAgent(d.agent));
          go.addEventListener("click", () => { closeDetail(); discuss(d.agent, `About "${d.title}": `); });
          r.appendChild(go);
        }
        host.appendChild(r);
      });
    };
  }

  // Everything the research found this week, including what did not make the
  // COO's cut, plus what it cost against what it was allowed.
  function researchDetail(R) {
    return (host) => {
      dLine(host, "Week", R.week);
      dLine(host, "Agents that researched", R.digests.length);
      if (R.budget) dLine(host, "Spent against budget", `$${R.spent.toFixed(2)} of $${R.budget.toFixed(2)}`);
      if (R.cooHeadline) dText(host, R.cooHeadline);
      const shown = R.worthKnowing || R.flagged || [];
      if (shown.length) {
        dSection(host, `Worth knowing · ${shown.length}`);
        shown.forEach((f) => host.appendChild(findingRow(f)));
      }
      R.digests.forEach((d) => {
        const rest = (d.findings || []).filter((f) => !shown.some((w) => w.id === f.id && w.agent === d.agent));
        dSection(host, `${shortAgent(d.agent)} · ${(d.findings || []).length} found`);
        if (d.summary) dText(host, d.summary);
        const bits = [];
        if (d.sourcesChecked != null) bits.push(d.sourcesChecked + " sources checked");
        if (d.sourcesNew) bits.push(d.sourcesNew + " new");
        if ((d.sourcesRetired || []).length) bits.push(d.sourcesRetired.length + " retired");
        if (d.spentUsd != null) bits.push("$" + Number(d.spentUsd).toFixed(2) + " spent");
        if (bits.length) dText(host, bits.join(" · "));
        rest.forEach((f) => host.appendChild(findingRow(Object.assign({ agent: d.agent }, f))));
      });
      if (!R.digests.length) dText(host, "No agent has written a research digest for this week yet. Research runs on Saturdays, before the Sunday ideas run.");
    };
  }

  function findingRow(f) {
    const r = el("div", "argus-item" + (f.tier === "high" ? " alert advisory" : ""));
    r.appendChild(el("div", "argus-item-title", f.title));
    const meta = [shortAgent(f.agent)];
    if (f.tier === "high") meta.push("high stakes - cross-checked");
    if (f.confidence) meta.push(f.confidence);
    if (f.couldBecomeIdea) meta.push("could become an idea");
    r.appendChild(el("div", "argus-item-meta", meta.filter(Boolean).join(" · ")));
    if (f.whatChanged) r.appendChild(el("div", "argus-detail-text", f.whatChanged));
    if (f.soWhat) r.appendChild(el("div", "argus-detail-text", "Why it matters: " + f.soWhat));
    sourceLinks(r, f.sources);
    addDiscuss(r, f.agent, `About what you found - "${f.title}": `);
    return r;
  }

  const recsFor = () => data.recommendations || {};

  function ideasDetail(recs) {
    return (host) => {
      if (!recs.items || !recs.items.length) {
        dText(host, "No ideas yet. Every agent writes 3-6 proposals for its own department each Sunday morning; the first set lands on Sunday 27 September.");
        return;
      }
      dLine(host, "Week", recs.week);
      recs.items.forEach((set) => {
        dSection(host, shortAgent(set.agent) + " · " + (set.items || []).length);
        if (set.headline) dText(host, set.headline);
        (set.items || []).forEach((it) => {
          const r = el("div", "argus-item idea");
          r.appendChild(el("div", "argus-item-title", it.title));
          r.appendChild(el("div", "argus-item-meta",
            `impact ${it.impact}/5 · effort ${it.effort} · ${it.cost || "cost not stated"}${it.needsIddo ? " · needs you" : ""}`));
          if (it.why) r.appendChild(el("div", "argus-detail-text", it.why));
          if (it.firstStep) r.appendChild(el("div", "argus-detail-text", "First step: " + it.firstStep));
          sourceLinks(r, it.sources);
          r.appendChild(verdictBar(it, recs.week, set.agent));
          addDiscuss(r, set.agent, `About your idea "${it.title}": `);
          host.appendChild(r);
        });
      });
    };
  }

  // One measurement, and the findings from the same part of the world.
  function metricDetail(a, m) {
    return (host) => {
      // "Now" is the number that was clicked to get here, so it jumps straight
      // to the list that explains it rather than being the one dead row on the
      // page (Iddo, 2026-09-23 - he pointed at exactly this figure).
      dLine(host, "Now", (m.value == null ? "–" : m.value) + (m.unit || ""), jumpTo("what this number counts"));
      dLine(host, "Previously", m.prev == null ? "no earlier figure" : m.prev + (m.unit || ""));
      dLine(host, "Better when", m.better === "up" ? "higher" : m.better === "down" ? "lower" : "—");
      dLine(host, "Reported by", shortAgent(a.agent));
      dLine(host, "From", a.source || "—");
      // Counts of open items, needs-you items and blocked items are lists in
      // disguise - show the list itself rather than a number and a shrug.
      const open = a.openItems || [];
      if (["open", "needsIddo", "blocked"].includes(m.id) && open.length) {
        const wanted = m.id === "needsIddo" ? open.filter((i) => i.needsIddo)
          : m.id === "blocked" ? open.filter((i) => i.status === "blocked") : open;
        dSection(host, `What this number counts · ${wanted.length}`);
        openItemRows(host, wanted, "Nothing in this category right now.", a.agent);
        dActions(host, a.agent, a.links, `About your open items: `);
        return;
      }
      // The Security card's counts ARE the findings, sliced by level.
      const byLevel = { warnings: "warning", cautions: "caution", advisories: "advisory" };
      if (byLevel[m.id] || m.id === "issues") {
        const wanted = m.id === "issues" ? (a.alerts || [])
          : (a.alerts || []).filter((al) => al.level === byLevel[m.id]);
        dSection(host, `What this number counts · ${wanted.length}`);
        if (!wanted.length) dText(host, "Nothing at this level right now.");
        wanted.forEach((al) => {
          const r = el("div", alertClass(al));
          r.appendChild(el("div", "argus-item-title", al.title));
          if (al.why) r.appendChild(el("div", "argus-detail-text", al.why));
          if (al.action) r.appendChild(el("div", "argus-detail-text", "Do: " + al.action));
          const bits = [];
          if (al.firstSeen) bits.push("first seen " + al.firstSeen);
          if (al.accepted) bits.push("parked" + (al.acceptedOn ? " on " + al.acceptedOn : ""));
          else if (!al.scored) bits.push("not scored");
          if (bits.length) r.appendChild(el("div", "argus-item-meta", bits.join(" · ")));
          parkedLine(al, r);
          addDiscuss(r, a.agent, `About the "${al.title}" finding: `);
          host.appendChild(r);
        });
        dActions(host, a.agent, a.links, `About the ${m.label.toLowerCase()} in your report: `);
        return;
      }
      const related = (a.alerts || []).filter((al) => al.domain && m.id &&
        String(al.domain).toLowerCase() === String(m.id).toLowerCase());
      if (related.length) {
        dSection(host, `What is behind this number · ${related.length}`);
        related.forEach((al) => {
          const r = el("div", alertClass(al));
          r.appendChild(el("div", "argus-item-title", al.title));
          if (al.why) r.appendChild(el("div", "argus-detail-text", al.why));
          if (al.action) r.appendChild(el("div", "argus-detail-text", "Do: " + al.action));
          parkedLine(al, r);
          addDiscuss(r, a.agent, `About the "${al.title}" finding: `);
          host.appendChild(r);
        });
      } else {
        dText(host, "No finding is filed against this measurement specifically. The full report has the workings behind it.");
      }
      dActions(host, a.agent, a.links, `About the "${m.label}" figure in your report: `);
    };
  }

  // Claude usage - the fleet's shared budget.
  function usageDetail(u) {
    return (host) => {
      dLine(host, "5-hour session window", u.fiveHourPct == null ? "unknown" : u.fiveHourPct + "% used");
      dLine(host, "7-day window", u.weekPct == null ? "unknown" : u.weekPct + "% used");
      dLine(host, "Weekly window resets", u.weekResetsAt ? new Date(u.weekResetsAt).toLocaleString() : "—");
      if ((u.topAgentsWeek || []).length) {
        dSection(host, "Who used it this week");
        u.topAgentsWeek.forEach((t) => {
          const folder = (data.agents || []).map((a) => a.agent)
            .find((f) => shortAgent(f) === shortAgent(t.agent || t.name || ""));
          const r = el("div", "argus-row");
          r.appendChild(el("span", "", shortAgent(t.agent || t.name || "?")));
          r.appendChild(el("span", "argus-row-val",
            (t.pct != null ? t.pct + "%" : t.messages != null ? t.messages + " messages" : "—")));
          addDiscuss(r, folder, "About your Claude usage this week: ");
          host.appendChild(r);
        });
      }
      const runs = ((data.fleet && data.fleet.agentRuns) || []).filter((r) => r.kind !== "ping").slice(-12).reverse();
      if (runs.length) {
        dSection(host, "Recent unattended runs, and what they cost");
        runs.forEach((run) => dLine(host,
          `${shortAgent(run.agent)} · ${run.kind} · ${new Date(run.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
          `${run.result} · ${run.turns ?? "?"} turns · ${run.apiEquivalentUsd != null ? "$" + Number(run.apiEquivalentUsd).toFixed(2) : "—"}`,
          () => openDetail(shortAgent(run.agent) + " — " + run.kind + " run", runDetail(run))));
      }
      // How much to trust the numbers above. Iddo, 2026-09-23: he wants the
      // meter's own accuracy reported weekly, with the change on last week.
      const acc = data.usageAccuracy;
      dSection(host, "How accurate is this percentage?");
      if (!acc || !acc.thisWeek) {
        dText(host, "Not measured yet. The System Optimization agent is logging each estimate against the next real reading; once a week of those exists this will show how far off we were and whether it is improving.");
      } else {
        if (acc.plainLine) dText(host, acc.plainLine);
        dLine(host, "Average error this week", acc.thisWeek.maePts != null
          ? acc.thisWeek.maePts + " points" + (acc.thisWeek.n ? " over " + acc.thisWeek.n + " readings" : "") : "—");
        dLine(host, "Last week", (acc.lastWeek && acc.lastWeek.maePts != null)
          ? acc.lastWeek.maePts + " points" + (acc.lastWeek.n ? " over " + acc.lastWeek.n + " readings" : "")
          : "no earlier figure");
        // A missing comparison is not an improvement of zero - the System
        // Optimization agent asked for this explicitly, and it is the same
        // honesty the rest of the Bridge applies to a missing previous value.
        dLine(host, "Change", acc.improvementPts == null
          ? "first week measured, no comparison yet"
          : (acc.improvementPts > 0 ? "improved by " : "worse by ") + Math.abs(acc.improvementPts) + " points");
        if (acc.thisWeek.worstMissPts != null) dLine(host, "Worst single miss", acc.thisWeek.worstMissPts + " points");
        if (acc.thisWeek.wallMaePts != null) dLine(host, "Error when a limit was actually hit", acc.thisWeek.wallMaePts + " points" +
          (acc.thisWeek.wallsN ? " over " + acc.thisWeek.wallsN + " limit hits" : ""));
        if (!(acc.walls || []).length) {
          dText(host, "Reading-to-reading error flatters the model, because each estimate starts from the last real reading. The honest test is how wrong it is when a limit is actually hit, and that fills in as real limits are reached.");
        }
        if (acc.capacity) {
          dLine(host, "Weekly capacity estimate", (acc.capacity.weeklyUnits != null ? acc.capacity.weeklyUnits + " units" : "—") +
            (acc.capacity.confidence ? " (" + acc.capacity.confidence + " confidence)" : ""));
          if (acc.capacity.basis) dText(host, "Based on: " + acc.capacity.basis);
        }
        (acc.walls || []).slice(-3).forEach((w) => {
          const r = el("div", "argus-item alert caution");
          r.appendChild(el("div", "argus-item-title",
            `Hit the ${w.window} limit ${w.at ? "on " + new Date(w.at).toLocaleString() : ""}`));
          r.appendChild(el("div", "argus-detail-text",
            `We were showing ${w.weShowedPct}% at the time - off by ${w.errorPts} points.`));
          host.appendChild(r);
        });
        addDiscuss(host, (data.agents || []).map((a) => a.agent).find((f) => f.startsWith("System Optimization")),
          "About the usage meter's accuracy this week: ");
      }
      dText(host, "These percentages come from the usage model in the System Optimization agent, which reads Claude's own rate-limit figures. When Anthropic's own banner disagrees with this number, believe the banner.");
    };
  }

  // ------------------------------------------- memory and starting context
  // Iddo, 2026-09-23 (relayed by the COO): show each agent's memory and
  // starting-context size here, with day-to-day growth, marked red on a
  // threshold or on unusual growth. The Optimization agent measures it and
  // owns the red rules; build_status.py attaches its row to each agent as
  // `context`. Nothing renders until that file exists - an empty frame would
  // imply a measurement is happening when it is not.
  const num = (n) => n == null ? "–" : typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(n);
  const tokens = (n) => n == null ? "–" : n >= 1000 ? Math.round(n / 100) / 10 + "K" : String(n);
  // "412.5 KB (400.1) ▲12.5" - a figure always appears next to the same
  // measurement last time. Growth is the whole point here, so the arrow is
  // plain direction rather than a better/worse judgement.
  const withPrev = (v, p, unit, fmt) => {
    const f = fmt || num;
    const s = el("span", "");
    s.append(f(v) + (unit ? " " + unit : ""));
    const c = el("span", "argus-cmp", p == null ? " (no earlier figure)" : " (" + f(p) + ")");
    if (p != null && typeof v === "number" && typeof p === "number" && v !== p) {
      const d = v - p;
      c.appendChild(el("span", "argus-delta", " " + (d > 0 ? "▲" : "▼") + f(Math.abs(Math.round(d * 10) / 10))));
    }
    s.appendChild(c);
    return s;
  };
  const ctxAgents = () => ((data && data.agents) || []).filter((a) => a.context);

  function contextDetail() {
    return (host) => {
      const rows = ctxAgents();
      if (!rows.length) {
        dText(host, "No agent memory or starting-context measurements yet. The Optimization agent writes them to shared_reports\\status\\_agent_context.json; until that file exists there is nothing to show.");
        return;
      }
      const th = (rows.find((a) => a.context.thresholds && Object.keys(a.context.thresholds).length) || rows[0]).context.thresholds || {};
      dText(host, "What each agent carries before it does any work: the memory files it loads, the memory index, the pinned memories, and the tokens its session starts with. Measured by the Optimization agent.");
      if (th.indexChars || th.startContextTokens) {
        dText(host, "Red when the memory index passes " + num(th.indexChars) + " characters or the starting context passes " + num(th.startContextTokens) +
          " tokens - or when either grows unusually in one day: index +" + num(th.indexGrowthPct) + "% or +" + num(th.indexGrowthChars) +
          " characters, starting context +" + num(th.startContextGrowthTokens) + " tokens.");
      }
      const order = [...rows].sort((a, b) => (b.context.red === true) - (a.context.red === true) ||
        (b.context.startContextTokens || 0) - (a.context.startContextTokens || 0));
      for (const a of order) {
        const c = a.context, prev = c.prev || {};
        const r = el("div", "argus-item" + (c.red ? " alert caution" : ""));
        const t = el("div", "argus-item-title");
        if (c.red) t.appendChild(el("span", "argus-lvl", "RED"));
        t.append(shortAgent(a.agent));
        r.appendChild(t);
        const grid = el("div", "argus-ctx-grid");
        const pair = (label, v, p, unit, fmt) => {
          const cell = el("div", "argus-ctx-cell");
          cell.appendChild(el("div", "argus-ctx-label", label));
          const val = el("div", "argus-ctx-val");
          val.appendChild(withPrev(v, p, unit, fmt));
          cell.appendChild(val);
          grid.appendChild(cell);
        };
        pair("Starting context", c.startContextTokens, prev.startContextTokens, "tokens", tokens);
        pair("Memory total", c.memoryKB, prev.memoryKB, "KB");
        pair("Memory index", c.indexChars, prev.indexChars, "chars");
        pair("Pinned", c.pinnedKB, prev.pinnedKB, "KB");
        pair("Files", c.memoryFiles, prev.memoryFiles, "");
        r.appendChild(grid);
        (c.redReasons || []).forEach((why) => r.appendChild(el("div", "argus-detail-text", why)));
        if (c.startContextTokensMethod) {
          r.appendChild(el("div", "argus-item-meta", "Starting context is an estimate: " + c.startContextTokensMethod));
        }
        if (c.measuredAt) r.appendChild(el("div", "argus-item-meta", "measured " + new Date(c.measuredAt).toLocaleString()));
        addDiscuss(r, a.agent, "About my memory and starting-context size: ");
        host.appendChild(r);
      }
    };
  }

  // Scheduled jobs - every job by name, not a count you cannot open.
  function jobsDetail(j) {
    return (host) => {
      const fmtAgo = (h) => h == null ? "—" : h < 1 ? Math.round(h * 60) + " min ago"
        : h < 48 ? Math.round(h) + "h ago" : Math.round(h / 24) + " days ago";
      // ageHours is how old the run was WHEN THE SNAPSHOT WAS TAKEN. Reading it
      // as "ago" turned a 13-hour-old snapshot into "last ran 30 min ago" for a
      // task that had actually last run 13.5 hours earlier. Measure from the
      // real timestamp whenever there is one.
      // Records that only carry ageHours (the outputs) get the snapshot's own
      // age added, which is the same correction by another route.
      const snapAgeH = j.checkedAt ? Math.max(0, (Date.now() - new Date(j.checkedAt).getTime()) / 36e5) : 0;
      const ago = (h, at) => at ? fmtAgo((Date.now() - new Date(at).getTime()) / 36e5)
        : h == null ? "—" : fmtAgo(h + snapAgeH);
      dLine(host, "Checked at", j.checkedAt ? new Date(j.checkedAt).toLocaleString() : "—");
      dLine(host, "Scheduled tasks", (j.tasksChecked ?? "?") + " checked, " + (j.tasksFailing ?? 0) + " failing", jumpTo("every scheduled task"));
      dLine(host, "Key outputs", (j.outputsChecked ?? "?") + " checked, " + (j.outputsFailing ?? 0) + " stale", jumpTo("every output checked"));

      const tasks = j.tasks || [];
      if (tasks.length) {
        dSection(host, `Every scheduled task · ${tasks.length}`);
        tasks.forEach((t) => {
          const r = el("div", "argus-item" + (t.ok ? "" : " alert caution"));
          const title = el("div", "argus-item-title", t.name || "unnamed task");
          // The list is longer than the count: disabled tasks are shown but not
          // checked, and "21 listed / 20 checked" needs saying, not guessing at.
          if ((j.disabled || []).includes(t.name)) title.appendChild(el("span", "argus-tag", "disabled - not counted"));
          r.appendChild(title);
          const bits = [t.state || "", "last ran " + ago(t.ageHours, t.lastRun)];
          if (t.nextRun) bits.push("next " + new Date(t.nextRun).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
          if (t.maxAgeHours != null) bits.push("expected within " + t.maxAgeHours + "h");
          if (t.lastResult != null) bits.push("exit " + t.lastResult);
          r.appendChild(el("div", "argus-item-meta", bits.filter(Boolean).join(" · ")));
          if (t.problem) r.appendChild(el("div", "argus-detail-text", t.problem));
          addDiscuss(r, agentForJob(t.name), `About the scheduled task ${t.name}: `);
          host.appendChild(r);
        });
      }

      const outputs = j.outputs || [];
      if (outputs.length) {
        dSection(host, `Every output checked · ${outputs.length}`);
        outputs.forEach((o) => {
          const r = el("div", "argus-item" + (o.ok ? "" : " alert caution"));
          r.appendChild(el("div", "argus-item-title", o.name || "unnamed output"));
          r.appendChild(el("div", "argus-item-meta", "written " + ago(o.ageHours, null) +
            (o.maxAgeHours != null ? " · expected within " + o.maxAgeHours + "h" : "")));
          if (o.file) r.appendChild(el("div", "argus-item-meta", o.file));
          if (o.problem) r.appendChild(el("div", "argus-detail-text", o.problem));
          addDiscuss(r, agentForJob(o.name, o.file), `About the "${o.name}" output: `);
          host.appendChild(r);
        });
      }

      if ((j.disabled || []).length) {
        dSection(host, `Disabled, so not checked · ${j.disabled.length}`);
        j.disabled.forEach((name) => dLine(host, name, "disabled"));
      }
      dText(host, "A Windows task reporting success is not proof the work happened - a task launches a hidden script and returns 0 either way. The check that matters is whether each job's output file is fresh, which is what the outputs above count.");
    };
  }

  // The COO's brief in full - the bottom line is only its first sentence.
  function briefDetail() {
    return (host) => {
      const b = data.brief;
      if (!b) {
        dText(host, "The COO has not written a brief yet. It runs unattended at 09:15 each day, after both morning reviews, and writes shared_reports\coo\brief_latest.json.");
        dActions(host, "COO Agent", null, "About today's brief: ");
        return;
      }
      dLine(host, "Written for", b.date);
      dLine(host, "Written at", b.writtenAt ? new Date(b.writtenAt).toLocaleString() : "—");
      dLine(host, "Agents read", b.agentsRead == null ? "—" : b.agentsRead);
      if (b.stale) dText(host, "This brief is not from today, so the Bridge is showing its own mechanical line instead. What follows is what the COO last wrote.");
      dSection(host, "Bottom line");
      dText(host, b.bottomLine);
      if ((b.changed || []).length) {
        dSection(host, "Changed since yesterday");
        b.changed.forEach((line) => dText(host, line));
      }
      if ((b.needsIddo || []).length) {
        dSection(host, "Needs you");
        b.needsIddo.forEach((line) => dText(host, line));
      }
      dActions(host, "COO Agent", null, "About today's brief: ");
    };
  }

  // One unattended run, with what it cost.
  function runDetail(r) {
    return (host) => {
      dLine(host, "Agent", shortAgent(r.agent));
      dLine(host, "Job", r.kind);
      dLine(host, "Started", new Date(r.at).toLocaleString());
      dLine(host, "Result", r.result + (r.exitCode != null ? " (exit " + r.exitCode + ")" : ""));
      dLine(host, "Turns used", (r.turns ?? "?") + (r.maxTurns ? " of " + r.maxTurns : ""));
      dLine(host, "Model", r.model || "—");
      dLine(host, "Duration", r.durationSec != null ? r.durationSec + "s" : "—");
      dLine(host, "API-equivalent cost", r.apiEquivalentUsd != null ? "$" + Number(r.apiEquivalentUsd).toFixed(4) : "—");
      dLine(host, "Output tokens", r.outputTokens == null ? "—" : r.outputTokens.toLocaleString());
      dLine(host, "Cache read tokens", r.cacheReadTokens == null ? "—" : r.cacheReadTokens.toLocaleString());
      if (r.refusedActions) dText(host, r.refusedActions + " action(s) were refused by the permission classifier during this run.");
      dText(host, "Every unattended run appends a line to shared_reports\agent_runs_ledger.jsonl, which is where these figures come from.");
      dActions(host, r.agent, null, `About your ${r.kind} run on ${new Date(r.at).toLocaleDateString()}: `);
    };
  }

  // ---------------------------------------------------------------- render
  function render() {
    [strip, colA, colB, colC].forEach((n) => { n.textContent = ""; });
    if (!data) return;
    stamp.textContent = "updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
      (data.builtOk ? "" : " · refresh failed, showing last data");

    // Merge alerts across agents.
    const merged = new Map();
    for (const a of data.agents) {
      for (const al of a.alerts || []) {
        const k = dedupeKey(al.title);
        const m = merged.get(k);
        if (m) {
          if (!m.agents.includes(shortAgent(a.agent))) m.agents.push(shortAgent(a.agent));
          if (ORDER[al.level] < ORDER[m.level]) m.level = al.level;
          m.scored = m.scored || al.scored;
        } else merged.set(k, Object.assign({}, al, { agents: [shortAgent(a.agent)], folder: a.agent }));
      }
    }
    const all = [...merged.values()].sort((x, y) =>
      ORDER[x.level] - ORDER[y.level] || (y.isNew ? 1 : 0) - (x.isNew ? 1 : 0) || (y.ageDays || 0) - (x.ageDays || 0));
    const live = all.filter((a) => a.scored), tracked = all.filter((a) => !a.scored);
    const W = live.filter((a) => a.level === "warning"), C = live.filter((a) => a.level === "caution"), V = live.filter((a) => a.level === "advisory");
    const D = data.decisions || [];

    const setLamp = (lamp, n, label, open) => {
      lamp.textContent = label + (n ? " " + n : "");
      lamp.classList.toggle("on", n > 0);
      lamp.onclick = open;
      lamp.title = n ? "Click to see all " + n : "Nothing at this level right now";
    };
    setLamp(lampW, W.length, "WARNING", () => openDetail(`Warnings · ${W.length}`, alertsDetail(W, [], [], [])));
    setLamp(lampC, C.length, "CAUTION", () => openDetail(`Cautions · ${C.length}`, alertsDetail([], C, [], [])));
    setLamp(lampD, D.length, "NEEDS YOU", () => openDetail(`Decision queue · ${D.length}`, decisionsDetail(D)));
    updateNav(W.length, C.length, D.length);

    // Glance: the number strip.
    const sec = data.agents.find((a) => a.agent === "Security");
    const opt = data.agents.find((a) => (a.agent || "").startsWith("System Optimization"));
    if (sec && sec.score) kpi("Security score", sec.score.value, sec.score.prev, "up", sec.score.value < 75, "",
      () => openDetail("Security score", agentDetail(sec)));
    if (opt && opt.score) kpi("Maintenance score", opt.score.value, opt.score.prev, "up", opt.score.value < 75, "",
      () => openDetail("Maintenance score", agentDetail(opt)));
    kpi("Needs you", D.length, null, "none", D.length > 0, "", () => document.getElementById("argus-decisions")?.scrollIntoView({ block: "start" }));
    const u = (data.fleet && data.fleet.usage) || {};
    kpi("Claude - this week", u.weekPct, null, "none", u.weekPct > 70, "%", () => openDetail("Claude usage", usageDetail(u)));
    kpi("Claude - 5 hours", u.fiveHourPct, null, "none", u.fiveHourPct > 70, "%", () => openDetail("Claude usage", usageDetail(u)));
    const j = (data.fleet && data.fleet.jobs) || {};
    if (j.tasksChecked != null) kpi("Scheduled jobs OK", (j.tasksChecked - j.tasksFailing) + "/" + j.tasksChecked, null, "none", j.tasksFailing > 0, "",
      () => openDetail("Scheduled jobs", jobsDetail(j)));
    if (agentStates.length) {
      const running = agentStates.filter((r) => r.state === "running").length;
      const idle = agentStates.filter((r) => r.state === "idle").length;
      const paused = agentStates.filter((r) => r.state === "paused").length;
      const unknown = agentStates.filter((r) => r.state === "unknown").length;
      const bits = [`${running} running`, `${idle} idle`];
      if (paused) bits.push(`${paused} paused`);
      if (unknown) bits.push(`${unknown} unknown`);
      const openRoster = () => openDetail(`Agents · ${agentStates.length}`, agentsDetail(agentStates));
      kpi("Agents", `${agentStates.length} (${running})`, null, "none", false, "", openRoster, bits.join(" · "));
      lampA.textContent = `AGENTS ${agentStates.length} (${running})`;
      lampA.title = `${agentStates.length} agents - ${bits.join(", ")}. Click for the list.`;
      lampA.onclick = openRoster;
      lampA.classList.toggle("live", running > 0);
      lampA.classList.remove("hidden");
    } else {
      lampA.classList.add("hidden");
    }

    // Column A: bottom line + Decision Queue.
    // The COO agent writes the bottom line (shared_reports\coo\brief_latest.json).
    // Only today's brief is used: a stale one is named as stale and the
    // mechanical line takes over, because the display research is explicit that
    // a tile must declare old data rather than present it as current.
    const bl = card(colA, "Bottom line", null, () => openDetail("Bottom line", briefDetail()));
    const brief = data.brief;
    const topW = W.slice(0, 3).map((a) => a.title.replace(/\.$/, ""));
    const mechanical = W.length
      ? `${W.length} warning${W.length > 1 ? "s need" : " needs"} action: ${topW.join("; ")}. ${C.length} caution${C.length === 1 ? "" : "s"}, ${D.length} decision${D.length === 1 ? "" : "s"} waiting on you.`
      : `No warnings. ${C.length} caution${C.length === 1 ? "" : "s"} and ${D.length} decision${D.length === 1 ? "" : "s"} waiting on you.`;
    if (brief && !brief.stale) {
      bl.appendChild(el("p", "argus-brief", brief.bottomLine));
      const lists = [["Changed since yesterday", brief.changed], ["Needs you", brief.needsIddo]];
      for (const [label, items] of lists) {
        if (!Array.isArray(items) || !items.length) continue;
        bl.appendChild(el("div", "argus-group", label));
        for (const line of items.slice(0, 5)) bl.appendChild(el("div", "argus-item-meta", line));
      }
      const writtenAt = brief.writtenAt ? new Date(brief.writtenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
      bl.appendChild(el("p", "argus-note", "Written by the COO" + (writtenAt ? " at " + writtenAt : "") + "."));
    } else {
      bl.appendChild(el("p", "argus-brief", mechanical));
      bl.appendChild(el("p", "argus-note", brief
        ? `Written mechanically - the COO's brief is from ${brief.date || "an earlier day"}, not today.`
        : "Written mechanically - the COO agent has not written a brief yet."));
    }

    const dq = card(colA, `Decision queue · ${D.length}`, "argus-decisions",
      () => openDetail(`Decision queue · ${D.length}`, decisionsDetail(D)));
    if (!D.length) dq.appendChild(el("p", "argus-quiet", "Nothing is waiting on you."));
    // Two layouts, because the two builders produce different things. The
    // heuristic queue has no ranking at all, so grouping by agent is the only
    // order it can honestly show. The COO's queue IS ranked, most important
    // first - grouping it by agent would throw that ranking away (v1.40.0:
    // rank 3 rendered below rank 4 the first time it ran), so it renders flat
    // in rank order with the owning agent shown on each row instead.
    const ranked = /coo/i.test(data.decisionsBuiltBy || "");
    const decisionRow = (d, showAgent) => {
      const r = el("div", "argus-item decision expandable");
      r.appendChild(el("div", "argus-item-title", d.title));
      const metaBits = [showAgent && d.agent ? shortAgent(d.agent) : null, d.group].filter(Boolean);
      if (metaBits.length) r.appendChild(el("div", "argus-item-meta", metaBits.join(" · ")));
      const more = el("div", "argus-item-more");
      more.appendChild(el("div", "argus-item-detail", d.detail));
      if (d.action) more.appendChild(el("div", "argus-item-detail", "→ " + d.action));
      if (d.agent) {
        const go = el("button", "argus-btn primary", "Discuss with " + shortAgent(d.agent));
        go.addEventListener("click", (ev) => { ev.stopPropagation(); discuss(d.agent, `About "${d.title}": `); });
        more.appendChild(go);
      }
      r.appendChild(more);
      r.addEventListener("click", () => r.classList.toggle("open"));
      return r;
    };
    if (ranked) {
      for (const d of D) dq.appendChild(decisionRow(d, true));
    } else {
      const byAgent = new Map();
      D.forEach((d) => { if (!byAgent.has(d.agent)) byAgent.set(d.agent, []); byAgent.get(d.agent).push(d); });
      for (const [agentFolder, items] of byAgent) {
        dq.appendChild(el("div", "argus-group", shortAgent(agentFolder)));
        for (const d of items) dq.appendChild(decisionRow(d, false));
      }
    }
    dq.appendChild(el("p", "argus-note", /coo/i.test(data.decisionsBuiltBy || "")
      ? "Ranked and de-duplicated by the COO, from every agent's open items."
      : "Collected from each agent's OPEN NOW list. The COO ranks this queue once it has run today."));

    // Column B: needs attention.
    const na = card(colB, `Needs attention · ${W.length + C.length}`, null,
      () => openDetail("Every finding", alertsDetail(W, C, V, tracked)));
    const alertRow = (a, host) => {
      const r = el("div", (a.accepted ? "argus-item alert expandable parked" : "argus-item alert expandable " + a.level));
      const t = el("div", "argus-item-title");
      t.appendChild(el("span", "argus-lvl", alertLvl(a)));
      t.append(a.title);
      r.appendChild(t);
      const meta = el("div", "argus-item-meta", a.agents.join(" + ") + (a.domain ? " · " + a.domain : ""));
      if (a.agents.length > 1) meta.appendChild(el("span", "argus-tag", "reported by " + a.agents.length));
      if (a.isNew) meta.appendChild(el("span", "argus-tag new", "new today"));
      else if (a.ageDays >= 7) meta.appendChild(el("span", "argus-tag", "standing " + a.ageDays + " days"));
      r.appendChild(meta);
      const more = el("div", "argus-item-more");
      if (a.why) more.appendChild(el("div", "argus-item-detail", "Why: " + a.why));
      if (a.action) more.appendChild(el("div", "argus-item-detail", "Do: " + a.action));
      const go = el("button", "argus-btn", "Discuss with " + a.agents[0]);
      go.addEventListener("click", (ev) => { ev.stopPropagation(); discuss(a.folder, `About the "${a.title}" finding: `); });
      more.appendChild(go);
      r.appendChild(more);
      r.addEventListener("click", () => r.classList.toggle("open"));
      host.appendChild(r);
    };
    if (!W.length && !C.length) na.appendChild(el("p", "argus-quiet", "All quiet."));
    W.concat(C).forEach((a) => alertRow(a, na));
    const det = el("details", "argus-more");
    det.appendChild(el("summary", "", `${V.length} advisories and ${tracked.length} tracked items (accepted risks, sites frozen for rebuild)`));
    V.concat(tracked).forEach((a) => alertRow(a, det));
    na.appendChild(det);

    // Column C: ideas, automation, departments.
    // The week's research, above the ideas it fed (v1.44.0). Two sections, as
    // Iddo asked: what the fleet learned that he should know, and the ideas
    // that came out of it - each expandable to its sources.
    const R = data.research;
    if (R) {
      const list = R.worthKnowing || R.flagged || [];
      const wk = card(colC, `Worth knowing · ${R.week}`, null, () => openDetail(`Worth knowing · ${R.week}`, researchDetail(R)));
      if (R.cooHeadline) wk.appendChild(el("p", "argus-brief", R.cooHeadline));
      if (!list.length) {
        wk.appendChild(el("p", "argus-quiet", R.digests.length
          ? "The agents researched this week and flagged nothing you need to act on."
          : "No research yet this week."));
      }
      list.slice(0, 6).forEach((f) => {
        const r = el("div", "argus-item expandable");
        r.appendChild(el("div", "argus-item-title", f.title));
        const meta = [shortAgent(f.agent)];
        if (f.tier === "high") meta.push("checked closely");
        if (f.confidence && f.confidence !== "confirmed") meta.push(f.confidence);
        r.appendChild(el("div", "argus-item-meta", meta.filter(Boolean).join(" · ")));
        const more = el("div", "argus-item-more");
        if (f.whatChanged) more.appendChild(el("div", "argus-item-detail", f.whatChanged));
        if (f.soWhat) more.appendChild(el("div", "argus-item-detail", "Why it matters: " + f.soWhat));
        sourceLinks(more, f.sources);
        const go = discussBtn(f.agent, `About what you found - "${f.title}": `);
        if (go) more.appendChild(go);
        r.appendChild(more);
        r.addEventListener("click", () => r.classList.toggle("open"));
        wk.appendChild(r);
      });
      wk.appendChild(el("p", "argus-note", R.worthKnowing
        ? "Chosen by the COO from everything the agents flagged this week."
        : "Flagged by the agents; the COO has not cut this down yet, so it is unfiltered."));
    }

    const ideas = card(colC, "Ideas this week", null, () => openDetail("Ideas this week", ideasDetail(recsFor())));
    const recs = data.recommendations || {};
    if (recs.items && recs.items.length) {
      ideas.appendChild(el("div", "argus-item-meta", "Week " + recs.week));
      for (const set of recs.items) {
        ideas.appendChild(el("div", "argus-group", shortAgent(set.agent)));
        if (set.headline) ideas.appendChild(el("p", "argus-idea-headline", set.headline));
        (set.items || []).slice(0, 4).forEach((it) => {
          const r = el("div", "argus-item idea expandable");
          r.appendChild(el("div", "argus-item-title", it.title));
          r.appendChild(el("div", "argus-item-meta", `impact ${it.impact}/5 · effort ${it.effort} · ${it.cost || ""}`));
          const more = el("div", "argus-item-more");
          more.appendChild(el("div", "argus-item-detail", it.why || ""));
          if (it.firstStep) more.appendChild(el("div", "argus-item-detail", "First step: " + it.firstStep));
          sourceLinks(more, it.sources);
          more.appendChild(verdictBar(it, recs.week, set.agent));
          const go = discussBtn(set.agent, `About your idea "${it.title}": `);
          if (go) more.appendChild(go);
          r.appendChild(more);
          r.addEventListener("click", () => r.classList.toggle("open"));
          ideas.appendChild(r);
        });
      }
    } else {
      ideas.appendChild(el("p", "argus-quiet", "The first weekly ideas arrive on Sunday 27 Sep: 3-6 proposals from each agent, to approve, park or reject here."));
    }

    const auto = card(colC, "Automation health", null, () => openDetail("Scheduled jobs", jobsDetail(j)));
    // The summary sentence IS the number, so the sentence has to open the list.
    // Iddo, 2026-09-23, arrow on "All 20 scheduled jobs ran on time": "pressing
    // this doesn't show me what are the actual 20 jobs - I want a list". Only
    // the card's own heading chevron was clickable, which is not where the eye
    // (or the finger) goes. jobsDetail already names every task - it just had
    // no way in from here.
    const openJobs = () => openDetail("Scheduled jobs", jobsDetail(j));
    if (!j.tasksFailing && !j.outputsFailing) {
      const line = el("div", "argus-row clickable");
      line.appendChild(el("span", "", `All ${j.tasksChecked || 0} scheduled jobs ran on time; ${j.outputsChecked || 0} key outputs are fresh.`));
      line.title = "Open the list of every job and output";
      line.addEventListener("click", openJobs);
      auto.appendChild(line);
    } else {
      (j.failing || []).forEach((f) => {
        const r = el("div", "argus-item alert caution clickable", (f.Task || f.Output) + ": " + f.Problem);
        r.addEventListener("click", openJobs);
        auto.appendChild(r);
      });
    }
    // When this snapshot was taken, always - it comes from the Optimization
    // agent's own check, not from the moment the Bridge was refreshed, and
    // "ran on time" read as current when the check itself was 13 hours old.
    if (j.checkedAt) {
      const hrs = (Date.now() - new Date(j.checkedAt).getTime()) / 36e5;
      const meta = el("div", "argus-item-meta", "checked " +
        (hrs < 1 ? Math.round(hrs * 60) + " min ago" : hrs < 48 ? Math.round(hrs) + "h ago" : Math.round(hrs / 24) + " days ago"));
      if (hrs > 3) meta.appendChild(el("span", "argus-tag stale", "not a live check"));
      auto.appendChild(meta);
    }
    const runs = ((data.fleet && data.fleet.agentRuns) || []).filter((r) => r.kind !== "ping").slice(-5).reverse();
    if (runs.length) {
      auto.appendChild(el("div", "argus-group", "Recent unattended agent runs"));
      runs.forEach((r) => {
        const row = el("div", "argus-row clickable",
          `${shortAgent(r.agent)} · ${r.kind} · ${r.result} · ${r.turns ?? "?"} turns · ${new Date(r.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`);
        row.addEventListener("click", () => openDetail(shortAgent(r.agent) + " — " + r.kind + " run", runDetail(r)));
        auto.appendChild(row);
      });
    }

    // Memory and starting context, per agent (2026-09-23). Only appears once
    // the Optimization agent has measured something - see contextDetail().
    const ctxRows = ctxAgents();
    if (ctxRows.length) {
      const ctxCard = card(colC, "Memory & starting context", null, () => openDetail("Memory & starting context", contextDetail()));
      const red = ctxRows.filter((a) => a.context.red);
      ctxCard.appendChild(el("p", "argus-quiet", red.length
        ? `${red.length} of ${ctxRows.length} agents are over a limit or growing unusually fast.`
        : `All ${ctxRows.length} agents are within their memory and starting-context limits.`));
      [...ctxRows]
        .sort((a, b) => (b.context.red === true) - (a.context.red === true) ||
          (b.context.startContextTokens || 0) - (a.context.startContextTokens || 0))
        .forEach((a) => {
          const row = el("div", "argus-row clickable");
          const name = el("span", "");
          if (a.context.red) name.appendChild(el("span", "argus-tag bad", "RED"));
          name.append(" " + shortAgent(a.agent));
          row.appendChild(name);
          const v = el("span", "argus-row-val");
          v.appendChild(withPrev(a.context.startContextTokens, (a.context.prev || {}).startContextTokens, "", tokens));
          row.appendChild(v);
          row.title = "Starting context in tokens. Click for every figure behind it.";
          row.addEventListener("click", () => openDetail("Memory & starting context", contextDetail()));
          ctxCard.appendChild(row);
        });
    }

    for (const a of data.agents) {
      const c = card(colC, a.department || shortAgent(a.agent), null, () => openDetail(a.department || shortAgent(a.agent), agentDetail(a)));
      const today = new Date().toISOString().slice(0, 10);
      const metaRow = el("div", "argus-item-meta", shortAgent(a.agent) + " · report " + (a.reportDate || "unknown"));
      if (a.reportDate !== today) metaRow.appendChild(el("span", "argus-tag stale", "not from today"));
      c.appendChild(metaRow);
      (a.metrics || []).forEach((m) => {
        const r = el("div", "argus-row clickable");
        r.appendChild(el("span", "", m.label));
        const v = el("span", "argus-row-val", m.value + (m.unit || "") + " ");
        v.appendChild(delta(m.value, m.prev, m.better));
        r.appendChild(v);
        r.addEventListener("click", () => openDetail(m.label + " — " + shortAgent(a.agent), metricDetail(a, m)));
        c.appendChild(r);
      });
    }
  }

  function updateNav(w, c, d) {
    navLamps.textContent = "";
    if (w) navLamps.appendChild(el("span", "argus-dot warn", String(w)));
    if (c) navLamps.appendChild(el("span", "argus-dot caut", String(c)));
    if (d) navLamps.appendChild(el("span", "argus-dot dec", String(d)));
    updateBadge(d);
  }

  async function load(refresh) {
    if (loading) return;
    loading = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    try {
      // Fetched alongside the Bridge's own data, not inside render(): render is
      // synchronous, and a tile that populated a moment later would flicker in
      // on every refresh. A failure here leaves the previous roster in place
      // rather than blanking the tile.
      const [next, roster] = await Promise.all([
        window.api.argusData({ refresh }),
        fleetAgentStates().catch(() => null),
      ]);
      data = next;
      if (roster) agentStates = roster;
      render();
    } catch (e) {
      console.error("[argus] load", e);
    } finally {
      loading = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh";
    }
  }

  // ---------------------------------------------------------------- header badge
  // "Needs you: N" in every agent's header (Iddo: the Decision Queue in the
  // Bridge, "maybe also in agent desktop head as well").
  let badge = null;
  let lastCount = 0;
  function updateBadge(n) {
    lastCount = n;
    const controls = document.querySelector("#chat-header .xp-controls");
    if (!controls) return;
    if (!badge || !controls.contains(badge)) {
      badge = el("button", "argus-badge");
      badge.title = "Decisions waiting on you, across all agents - opens Argus";
      badge.addEventListener("click", () => openArgus("decisions"));
      controls.insertBefore(badge, controls.firstChild);
    }
    badge.textContent = "Needs you " + n;
    badge.classList.toggle("none", !n);
  }
  async function pollBadge() {
    try { updateBadge(await window.api.argusDecisionCount()); } catch (e) { /* keep last */ }
  }
  // The chat header is rebuilt on agent switch; put the badge back.
  new MutationObserver(() => {
    const controls = document.querySelector("#chat-header .xp-controls");
    if (controls && (!badge || !controls.contains(badge))) updateBadge(lastCount);
  }).observe(document.getElementById("chat-view") || document.body, { childList: true, subtree: true });

  // Sidebar lamps without a rebuild: read last data on start.
  window.api.argusData({ refresh: false }).then((d) => { data = d; render(); }).catch(() => {});
  pollBadge();
  setInterval(pollBadge, BADGE_MS);
})();

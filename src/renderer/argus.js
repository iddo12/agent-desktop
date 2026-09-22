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
  const lampW = el("span", "argus-lamp warn", "WARNING");
  const lampC = el("span", "argus-lamp caut", "CAUTION");
  const lampD = el("span", "argus-lamp dec", "NEEDS YOU");
  lamps.append(lampW, lampC, lampD);
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
  function kpi(label, val, prev, better, bad, unit, onClick) {
    const k = el("div", "argus-kpi" + (bad ? " bad" : "") + (onClick ? " clickable" : ""));
    k.appendChild(el("div", "argus-kpi-label", label));
    k.appendChild(el("div", "argus-kpi-val", (val == null ? "–" : val) + (unit || "")));
    k.appendChild(delta(val, prev, better));
    if (onClick) k.addEventListener("click", onClick);
    strip.appendChild(k);
  }
  function card(host, heading, id) {
    const c = el("section", "argus-card");
    if (id) c.id = id;
    const h = el("h2", "argus-card-head", heading);
    c.appendChild(h);
    host.appendChild(c);
    return c;
  }
  function dedupeKey(t) {
    return (t || "").toLowerCase().replace(/\d+([.,]\d+)?/g, "").replace(/[^a-z]+/g, " ")
      .split(" ").filter((w) => w.length > 3).sort().filter((w, i, a) => a.indexOf(w) === i).join(" ");
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

    const setLamp = (lamp, n, label) => { lamp.textContent = label + (n ? " " + n : ""); lamp.classList.toggle("on", n > 0); };
    setLamp(lampW, W.length, "WARNING"); setLamp(lampC, C.length, "CAUTION"); setLamp(lampD, D.length, "NEEDS YOU");
    updateNav(W.length, C.length, D.length);

    // Glance: the number strip.
    const sec = data.agents.find((a) => a.agent === "Security");
    const opt = data.agents.find((a) => (a.agent || "").startsWith("System Optimization"));
    if (sec && sec.score) kpi("Security score", sec.score.value, sec.score.prev, "up", sec.score.value < 75);
    if (opt && opt.score) kpi("Maintenance score", opt.score.value, opt.score.prev, "up", opt.score.value < 75);
    kpi("Needs you", D.length, null, "none", D.length > 0, "", () => document.getElementById("argus-decisions")?.scrollIntoView({ block: "start" }));
    const u = (data.fleet && data.fleet.usage) || {};
    kpi("Claude - this week", u.weekPct, null, "none", u.weekPct > 70, "%");
    kpi("Claude - 5 hours", u.fiveHourPct, null, "none", u.fiveHourPct > 70, "%");
    const j = (data.fleet && data.fleet.jobs) || {};
    if (j.tasksChecked != null) kpi("Scheduled jobs OK", (j.tasksChecked - j.tasksFailing) + "/" + j.tasksChecked, null, "none", j.tasksFailing > 0);

    // Column A: bottom line + Decision Queue.
    // The COO agent writes the bottom line (shared_reports\coo\brief_latest.json).
    // Only today's brief is used: a stale one is named as stale and the
    // mechanical line takes over, because the display research is explicit that
    // a tile must declare old data rather than present it as current.
    const bl = card(colA, "Bottom line");
    const brief = data.brief;
    const topW = W.slice(0, 3).map((a) => a.title.replace(/\.$/, ""));
    const mechanical = W.length
      ? `${W.length} warning${W.length > 1 ? "s" : ""} need action: ${topW.join("; ")}. ${C.length} caution${C.length === 1 ? "" : "s"}, ${D.length} decision${D.length === 1 ? "" : "s"} waiting on you.`
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

    const dq = card(colA, `Decision queue · ${D.length}`, "argus-decisions");
    if (!D.length) dq.appendChild(el("p", "argus-quiet", "Nothing is waiting on you."));
    // Two layouts, because the two builders produce different things. The
    // heuristic queue has no ranking at all, so grouping by agent is the only
    // order it can honestly show. The COO's queue IS ranked, most important
    // first - grouping it by agent would throw that ranking away (v1.40.0:
    // rank 3 rendered below rank 4 the first time it ran), so it renders flat
    // in rank order with the owning agent shown on each row instead.
    const ranked = /coo/i.test(data.decisionsBuiltBy || "");
    const decisionRow = (d, showAgent) => {
      const r = el("div", "argus-item decision");
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
    const na = card(colB, `Needs attention · ${W.length + C.length}`);
    const alertRow = (a, host) => {
      const r = el("div", "argus-item alert " + a.level);
      const t = el("div", "argus-item-title");
      t.appendChild(el("span", "argus-lvl", a.level.toUpperCase()));
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
    const ideas = card(colC, "Ideas this week");
    const recs = data.recommendations || {};
    if (recs.items && recs.items.length) {
      ideas.appendChild(el("div", "argus-item-meta", "Week " + recs.week));
      for (const set of recs.items) {
        ideas.appendChild(el("div", "argus-group", shortAgent(set.agent)));
        if (set.headline) ideas.appendChild(el("p", "argus-idea-headline", set.headline));
        (set.items || []).slice(0, 4).forEach((it) => {
          const r = el("div", "argus-item idea");
          r.appendChild(el("div", "argus-item-title", it.title));
          r.appendChild(el("div", "argus-item-meta", `impact ${it.impact}/5 · effort ${it.effort} · ${it.cost || ""}`));
          const more = el("div", "argus-item-more");
          more.appendChild(el("div", "argus-item-detail", it.why || ""));
          if (it.firstStep) more.appendChild(el("div", "argus-item-detail", "First step: " + it.firstStep));
          r.appendChild(more);
          r.addEventListener("click", () => r.classList.toggle("open"));
          ideas.appendChild(r);
        });
      }
    } else {
      ideas.appendChild(el("p", "argus-quiet", "The first weekly ideas arrive on Sunday 27 Sep: 3-6 proposals from each agent, to approve, park or reject here."));
    }

    const auto = card(colC, "Automation health");
    if (!j.tasksFailing && !j.outputsFailing) {
      auto.appendChild(el("p", "argus-quiet", `All ${j.tasksChecked || 0} scheduled jobs ran on time; ${j.outputsChecked || 0} key outputs are fresh.`));
    } else {
      (j.failing || []).forEach((f) => auto.appendChild(el("div", "argus-item alert caution", (f.Task || f.Output) + ": " + f.Problem)));
    }
    const runs = ((data.fleet && data.fleet.agentRuns) || []).filter((r) => r.kind !== "ping").slice(-5).reverse();
    if (runs.length) {
      auto.appendChild(el("div", "argus-group", "Recent unattended agent runs"));
      runs.forEach((r) => auto.appendChild(el("div", "argus-row",
        `${shortAgent(r.agent)} · ${r.kind} · ${r.result} · ${r.turns ?? "?"} turns · ${new Date(r.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`)));
    }

    for (const a of data.agents) {
      const c = card(colC, a.department || shortAgent(a.agent));
      const today = new Date().toISOString().slice(0, 10);
      const metaRow = el("div", "argus-item-meta", shortAgent(a.agent) + " · report " + (a.reportDate || "unknown"));
      if (a.reportDate !== today) metaRow.appendChild(el("span", "argus-tag stale", "not from today"));
      c.appendChild(metaRow);
      (a.metrics || []).forEach((m) => {
        const r = el("div", "argus-row");
        r.appendChild(el("span", "", m.label));
        const v = el("span", "argus-row-val", m.value + (m.unit || "") + " ");
        v.appendChild(delta(m.value, m.prev, m.better));
        r.appendChild(v);
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
      data = await window.api.argusData({ refresh });
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

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
  const lampW = el("span", "argus-lamp warn clickable", "WARNING");
  const lampC = el("span", "argus-lamp caut clickable", "CAUTION");
  const lampD = el("span", "argus-lamp dec clickable", "NEEDS YOU");
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
  function card(host, heading, id, onClick) {
    const c = el("section", "argus-card");
    if (id) c.id = id;
    const h = el("h2", "argus-card-head" + (onClick ? " clickable" : ""), heading);
    if (onClick) h.addEventListener("click", onClick);
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
      const alerts = a.alerts || [];
      if (alerts.length) {
        dSection(host, `Findings it raised · ${alerts.length}`);
        alerts.forEach((al) => {
          const r = el("div", "argus-item alert " + al.level);
          const t = el("div", "argus-item-title");
          t.appendChild(el("span", "argus-lvl", (al.level || "").toUpperCase()));
          t.append(al.title);
          r.appendChild(t);
          if (al.why) r.appendChild(el("div", "argus-detail-text", al.why));
          if (al.action) r.appendChild(el("div", "argus-detail-text", "Do: " + al.action));
          const bits = [];
          if (al.firstSeen) bits.push("first seen " + al.firstSeen);
          if (al.ageDays >= 1) bits.push("standing " + al.ageDays + (al.ageDays === 1 ? " day" : " days"));
          if (!al.scored) bits.push("not scored - tracked, not counted against the score");
          if (bits.length) r.appendChild(el("div", "argus-item-meta", bits.join(" · ")));
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
          const r = el("div", "argus-item alert " + a.level);
          const t = el("div", "argus-item-title");
          t.appendChild(el("span", "argus-lvl", a.level.toUpperCase()));
          t.append(a.title);
          r.appendChild(t);
          r.appendChild(el("div", "argus-item-meta", (a.agents || []).join(" + ") +
            (a.domain ? " · " + a.domain : "") +
            (a.firstSeen ? " · first seen " + a.firstSeen : "")));
          if (a.why) r.appendChild(el("div", "argus-detail-text", a.why));
          if (a.action) r.appendChild(el("div", "argus-detail-text", "Do: " + a.action));
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
          const r = el("div", "argus-item alert " + al.level);
          r.appendChild(el("div", "argus-item-title", al.title));
          if (al.why) r.appendChild(el("div", "argus-detail-text", al.why));
          if (al.action) r.appendChild(el("div", "argus-detail-text", "Do: " + al.action));
          const bits = [];
          if (al.firstSeen) bits.push("first seen " + al.firstSeen);
          if (!al.scored) bits.push("not scored");
          if (bits.length) r.appendChild(el("div", "argus-item-meta", bits.join(" · ")));
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
          const r = el("div", "argus-item alert " + al.level);
          r.appendChild(el("div", "argus-item-title", al.title));
          if (al.why) r.appendChild(el("div", "argus-detail-text", al.why));
          if (al.action) r.appendChild(el("div", "argus-detail-text", "Do: " + al.action));
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
      dText(host, "These percentages come from the usage model in the System Optimization agent, which reads Claude's own rate-limit figures. When Anthropic's own banner disagrees with this number, believe the banner.");
    };
  }

  // Scheduled jobs - every job by name, not a count you cannot open.
  function jobsDetail(j) {
    return (host) => {
      const ago = (h) => h == null ? "—" : h < 1 ? Math.round(h * 60) + " min ago"
        : h < 48 ? Math.round(h) + "h ago" : Math.round(h / 24) + " days ago";
      dLine(host, "Checked at", j.checkedAt ? new Date(j.checkedAt).toLocaleString() : "—");
      dLine(host, "Scheduled tasks", (j.tasksChecked ?? "?") + " checked, " + (j.tasksFailing ?? 0) + " failing", jumpTo("every scheduled task"));
      dLine(host, "Key outputs", (j.outputsChecked ?? "?") + " checked, " + (j.outputsFailing ?? 0) + " stale", jumpTo("every output checked"));

      const tasks = j.tasks || [];
      if (tasks.length) {
        dSection(host, `Every scheduled task · ${tasks.length}`);
        tasks.forEach((t) => {
          const r = el("div", "argus-item" + (t.ok ? "" : " alert caution"));
          r.appendChild(el("div", "argus-item-title", t.name || "unnamed task"));
          const bits = [t.state || "", "last ran " + ago(t.ageHours)];
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
          r.appendChild(el("div", "argus-item-meta", "written " + ago(o.ageHours) +
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

    // Column A: bottom line + Decision Queue.
    // The COO agent writes the bottom line (shared_reports\coo\brief_latest.json).
    // Only today's brief is used: a stale one is named as stale and the
    // mechanical line takes over, because the display research is explicit that
    // a tile must declare old data rather than present it as current.
    const bl = card(colA, "Bottom line", null, () => openDetail("Bottom line", briefDetail()));
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
      const r = el("div", "argus-item alert expandable " + a.level);
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
          r.appendChild(more);
          r.addEventListener("click", () => r.classList.toggle("open"));
          ideas.appendChild(r);
        });
      }
    } else {
      ideas.appendChild(el("p", "argus-quiet", "The first weekly ideas arrive on Sunday 27 Sep: 3-6 proposals from each agent, to approve, park or reject here."));
    }

    const auto = card(colC, "Automation health", null, () => openDetail("Scheduled jobs", jobsDetail(j)));
    if (!j.tasksFailing && !j.outputsFailing) {
      auto.appendChild(el("p", "argus-quiet", `All ${j.tasksChecked || 0} scheduled jobs ran on time; ${j.outputsChecked || 0} key outputs are fresh.`));
    } else {
      (j.failing || []).forEach((f) => auto.appendChild(el("div", "argus-item alert caution", (f.Task || f.Output) + ": " + f.Problem)));
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

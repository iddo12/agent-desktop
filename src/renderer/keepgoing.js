// v1.69.0 "Keep going", renderer half (main half: src/keepGoingGlue.js, logic: src/keepGoing.js). Loaded last and isolated
// like connection-health.js: every entry point is try/catch-wrapped, so a bug here can only disable this feature.
// No timers beyond one cheap 2 s check that the active agent changed (a string compare).
//  1. A small header toggle "Keep going: on/off" for the open agent (shift-click = all agents).
//  2. When an agent was nudged the allowed number of times and still stopped although nobody blocked it, a calm amber banner
//     in its chat ("Stopped - nobody blocked it") with one button that tells it to continue, plus an amber badge in the
//     sidebar (header-tasks.js needsOf asks window.keepGoingStopped).
//  3. v1.74.0 "Keep working regardless" (relentless mode): a per-agent switch and a fleet switch next to it, plus one muted line
//     with the latest reason this agent is idle ("why") or "out of projects". ARGUS reads window.keepGoingWhy(path).
(function () {
  "use strict";
  const states = new Map();       // agentPath -> main-process snapshot
  let globalEnabled = true;
  let fleetRelentless = false;
  let shownFor = null;

  function norm(p) { return String(p || "").replace(/[\\/]+$/, "").toLowerCase(); }
  function st(p) { return states.get(norm(p)) || null; }
  function agentOn(p) { const s = st(p); return !s || s.agentEnabled !== false; }

  window.keepGoingStopped = function (agentPath) {
    const s = st(agentPath);
    return s && s.state === "stopped" ? "Stopped - nobody blocked it: the agent ended its turn announcing a next step and " + (s.consecutive || "several") + " nudges did not get it moving. Open its chat." : null;
  };

  // v1.74.0: one short line for ARGUS / the header: why is this agent idle (latest keep-going decision), or null
  window.keepGoingWhy = function (agentPath) {
    const s = st(agentPath);
    if (!s || !s.relentless && !s.outOfProjects) return null;
    if (s.outOfProjects) return "Out of projects: " + (s.outOfProjectsReason || "NOTHING-LEFT").replace(/^NOTHING-LEFT:\s*/, "");
    if (s.state === "stopped") return "Stopped: " + (s.reason || "nudges did not help");
    if (s.relentless && s.attached === false) return "Not connected: the app has no terminal on this agent, so it cannot be nudged. Open the agent once.";
    if (s.relentless && s.deliveryFailed) return "The last nudge did not reach the agent (dead terminal). Use Session > Restart Session.";
    const w = s.why;
    if (!w) return s.relentless ? "Not judged yet since the app started." : null;
    const d = new Date(w.at), hh = (x) => (x < 10 ? "0" : "") + x;
    return w.reason + " (since " + hh(d.getHours()) + ":" + hh(d.getMinutes()) + ")";
  };

  function relBtn(id, onClick) {
    let b = document.getElementById(id);
    if (b) return b;
    const k = document.getElementById("keepgoing-btn");
    if (!k || !k.parentNode) return null;
    b = document.createElement("button");
    b.id = id;
    b.setAttribute("role", "switch");
    b.addEventListener("click", () => { try { onClick(); } catch (err) { /* cosmetic */ } });
    k.parentNode.insertBefore(b, k.nextSibling);
    return b;
  }

  function btn() {
    let b = document.getElementById("keepgoing-btn");
    if (b) return b;
    const row = document.querySelector("#chat-header .xp-status");   // v1.71.0: docks at the start of the status row
    const anchor = document.getElementById("pause-agent-btn");
    if (!row && (!anchor || !anchor.parentNode)) return null;
    b = document.createElement("button");
    b.id = "keepgoing-btn";
    b.setAttribute("role", "switch");
    b.addEventListener("click", (e) => {
      try {
        const p = typeof activeAgentPath === "undefined" ? null : activeAgentPath;
        if (e.shiftKey) {
          window.api.keepGoingSet(null, !globalEnabled).then((r) => { if (r) globalEnabled = r.globalEnabled; paint(); });
        } else if (p) {
          window.api.keepGoingSet(p, !agentOn(p));
        }
      } catch (err) { /* cosmetic */ }
    });
    if (row) row.insertBefore(b, row.firstChild); else anchor.parentNode.insertBefore(b, anchor);
    return b;
  }

  function bannerEl() {
    let el = document.getElementById("keepgoing-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "keepgoing-banner";
      el.className = "hidden";
      const q = document.getElementById("chat-queue");
      if (q && q.parentNode) q.parentNode.insertBefore(el, q);
    }
    return el;
  }

  function paint() {
    try {
      const p = typeof activeAgentPath === "undefined" ? null : activeAgentPath;
      shownFor = p;
      const b = btn();
      if (b) {
        const on = globalEnabled && (!p || agentOn(p));
        b.textContent = "Keep going";                       // v1.71.0: a switch (look in styles-topbar.css); state in aria-checked + tooltip
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.className = on ? "keepgoing-on" : "keepgoing-off";
        b.title = "Keep going is " + (on ? "ON" : "OFF") + ". When this agent ends a turn by announcing a next step although nothing blocks it, send it a short nudge to do it now (at most 3 in a row, never the same message twice). " +
          "The agent can stop it any time by ending with a line 'BLOCKED: <reason>' or 'DONE: <summary>'. Click: this agent. Shift-click: all agents (now " + (globalEnabled ? "on" : "off") + ").";
      }
      // v1.74.0: relentless switches (docked right after the Keep going switch; fleet switch after the agent one)
      const rb = relBtn("keepgoing-rel-btn", () => {
        const q = typeof activeAgentPath === "undefined" ? null : activeAgentPath;
        const s0 = q ? st(q) : null;
        if (q) window.api.keepGoingSetRelentless(q, !(s0 && s0.agentRelentless));
      });
      if (rb) {
        const s1 = p ? st(p) : null, on = !!(s1 && s1.agentRelentless);
        rb.textContent = "Keep working regardless";
        rb.setAttribute("aria-checked", on ? "true" : "false");
        rb.className = on ? "keepgoing-on" : "keepgoing-off";
        rb.title = "Keep working regardless is " + (on ? "ON" : "OFF") + " for this agent. Iddo's order: do not stop when you report DONE or BLOCKED, ask a question or just report - " +
          "go on with the next open task that needs no Iddo (tasks.py list). Up to 12 nudges in a row, 40 per 2 h. It stops only when the agent writes 'NOTHING-LEFT: <reason>', when the fleet throttle is HOLD, or when usage is at 95% (7 days or 5 hours). " +
          "Never pushes an agent into publish/send/push/delete. Survives restarts and handoffs. Click: this agent.";
      }
      const fb = relBtn("keepgoing-fleet-btn", () => {
        window.api.keepGoingSetRelentless(null, !fleetRelentless).then((r) => { if (r && r.relentless) fleetRelentless = !!r.relentless.fleet; paint(); });
      });
      if (fb) {
        fb.textContent = "all agents";
        fb.setAttribute("aria-checked", fleetRelentless ? "true" : "false");
        fb.className = fleetRelentless ? "keepgoing-on" : "keepgoing-off";
        fb.title = "Keep working regardless for ALL agents is " + (fleetRelentless ? "ON" : "OFF") + " (default off). Same order as the per-agent switch, applied to every agent. Turning it ON wakes EVERY idle agent whose last turn ended within 24 h (nudges paced 30 s apart); prefer the per-agent switch for the few agents with a real backlog. Click to switch. It overrides the 85% usage throttle and stops only at 95% usage or while the PC is overloaded (CPU guard).";
      }
      const el = bannerEl();
      const s = p ? st(p) : null;
      const why = p ? window.keepGoingWhy(p) : null;
      let wl = document.getElementById("keepgoing-why");
      if (!wl && rb && rb.parentNode) {
        // the stall reason lives on the status line below the switches (next to tokens / msgs / cache), not between the switches
        wl = document.createElement("span"); wl.id = "keepgoing-why";
        const cs = document.getElementById("cache-status");
        const anchor = cs && cs.parentNode ? cs : fb;
        anchor.parentNode.insertBefore(wl, anchor.nextSibling);
      }
      if (wl) { wl.textContent = why || ""; wl.title = why || ""; wl.className = why ? "" : "hidden"; }
      if (s && s.state === "stopped") {
        el.className = "";
        el.textContent = "";
        const msg = document.createElement("span");
        msg.textContent = "Stopped - nobody blocked it. This agent ended its turn announcing a next step and " + (s.consecutive || "several") + " nudges did not get it moving.";
        const go = document.createElement("button");
        go.textContent = "Tell it to continue";
        go.addEventListener("click", () => {
          try { submitToAgent(p, "Please carry on with the next step you announced, now, using tool calls."); } catch (e) { /* ignore */ }
        });
        el.appendChild(msg);
        el.appendChild(go);
      } else {
        el.className = "hidden";
      }
      if (typeof window.xpApplyAgentStates === "function") window.xpApplyAgentStates();
    } catch (e) { /* never break the chat */ }
  }

  function onState(snap) {
    try {
      if (!snap || !snap.agentPath) return;
      globalEnabled = snap.globalEnabled !== false;
      if (typeof snap.fleetRelentless === "boolean") fleetRelentless = snap.fleetRelentless;
      states.set(norm(snap.agentPath), snap);
      paint();
    } catch (e) { /* ignore */ }
  }

  try {
    window.api.onKeepGoingState(onState);
    window.api.keepGoingGet().then((r) => {
      if (!r) return;
      globalEnabled = r.globalEnabled !== false;
      (r.disabled || []).forEach((p) => states.set(norm(p), { agentPath: p, agentEnabled: false, state: "ok" }));
      if (r.relentless) fleetRelentless = !!r.relentless.fleet;
      (r.stopped || []).forEach(onState);
      (r.agentStates || []).forEach(onState);
      paint();
    }).catch(() => {});
    setInterval(() => { try { const p = typeof activeAgentPath === "undefined" ? null : activeAgentPath; if (p !== shownFor) paint(); } catch (e) { /* ignore */ } }, 2000);
    paint();
  } catch (e) { /* older preload: feature stays off */ }
})();

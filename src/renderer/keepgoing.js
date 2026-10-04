// v1.69.0 "Keep going", renderer half (main half: src/keepGoingGlue.js, logic: src/keepGoing.js). Loaded last and isolated
// like connection-health.js: every entry point is try/catch-wrapped, so a bug here can only disable this feature.
// No timers beyond one cheap 2 s check that the active agent changed (a string compare).
//  1. A small header toggle "Keep going: on/off" for the open agent (shift-click = all agents).
//  2. When an agent was nudged the allowed number of times and still stopped although nobody blocked it, a calm amber banner
//     in its chat ("Stopped - nobody blocked it") with one button that tells it to continue, plus an amber badge in the
//     sidebar (header-tasks.js needsOf asks window.keepGoingStopped).
(function () {
  "use strict";
  const states = new Map();       // agentPath -> main-process snapshot
  let globalEnabled = true;
  let shownFor = null;

  function norm(p) { return String(p || "").replace(/[\\/]+$/, "").toLowerCase(); }
  function st(p) { return states.get(norm(p)) || null; }
  function agentOn(p) { const s = st(p); return !s || s.agentEnabled !== false; }

  window.keepGoingStopped = function (agentPath) {
    const s = st(agentPath);
    return s && s.state === "stopped" ? "Stopped - nobody blocked it: the agent ended its turn announcing a next step and " + (s.consecutive || "several") + " nudges did not get it moving. Open its chat." : null;
  };

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
      const el = bannerEl();
      const s = p ? st(p) : null;
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
      (r.stopped || []).forEach(onState);
      paint();
    }).catch(() => {});
    setInterval(() => { try { const p = typeof activeAgentPath === "undefined" ? null : activeAgentPath; if (p !== shownFor) paint(); } catch (e) { /* ignore */ } }, 2000);
    paint();
  } catch (e) { /* older preload: feature stays off */ }
})();

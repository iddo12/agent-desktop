// v1.69.0: main-process half of "Keep going" (decision logic: src/keepGoing.js). Event-light: it rides on the existing
// 30 s halted-turn tick, reads a transcript tail ONLY when an agent's transcript changed since the last look (stat
// signature), and reads the fleet throttle file at most once a minute. All I/O is injected, so it is unit-tested
// (tests/keepGoingGlue.test.js) without Electron.
//
// Safety rails (all enforced here, all logged): at most 3 consecutive nudges per agent without a new human message or
// real progress (tool calls after a nudge), 90 s between nudges, never the same message twice, a 10-per-2h ceiling
// even with progress, 20 s between any two nudges fleet-wide, a global and a per-agent switch (persisted).
// After the cap the agent is marked "stopped - nobody blocked it" (state "stopped", an amber needs-attention state).
"use strict";
const K = require("./keepGoing");

function create(deps) {
  const L = Object.assign({}, K.LIMITS, deps.limits || {});
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const store = deps.storage || { load: () => ({}), save: () => {} };

  let P = {};
  try { P = store.load() || {}; } catch (e) { P = {}; }
  if (typeof P.globalEnabled !== "boolean") P.globalEnabled = true;
  P.agents = P.agents || {};     // path -> { enabled: false }   (only overrides are stored)
  P.mission = P.mission || {};   // path -> { active, since, path, firstTurnDone }
  P.counters = P.counters || {}; // path -> { consecutive, lastNudgeAt, hashes[], recent[], humanTs, stopped, stoppedAt, stoppedReason }
  const rt = new Map();          // path -> { lastSig, deferred, inflight }
  let lastGlobalNudgeAt = 0;
  let dirty = false;

  function save() { dirty = false; try { store.save(P); } catch (e) { log("keepgoing: could not persist settings: " + e.message); } }
  function R(p) { let r = rt.get(p); if (!r) { r = { lastSig: null, deferred: false, inflight: false }; rt.set(p, r); } return r; }
  function C(p) {
    let c = P.counters[p];
    if (!c) c = P.counters[p] = { consecutive: 0, lastNudgeAt: 0, hashes: [], recent: [], humanTs: 0, stopped: false, stoppedAt: 0, stoppedReason: "" };
    return c;
  }
  function enabledFor(p) { return P.globalEnabled && !(P.agents[p] && P.agents[p].enabled === false); }
  function snap(p) {
    const c = P.counters[p] || {};
    return { agentPath: p, state: c.stopped ? "stopped" : "ok", enabled: enabledFor(p), agentEnabled: !(P.agents[p] && P.agents[p].enabled === false),
      globalEnabled: P.globalEnabled, consecutive: c.consecutive || 0, since: c.stoppedAt || 0, reason: c.stoppedReason || "",
      mission: !!(P.mission[p] && P.mission[p].active) };
  }
  function emit(p) { try { deps.emit && deps.emit(p, snap(p)); } catch (e) { /* never break the tick */ } }
  function clearStopped(p, why) {
    const c = P.counters[p];
    if (c && c.stopped) { c.stopped = false; c.stoppedReason = ""; dirty = true; log("keepgoing: " + p + " no longer marked stopped (" + why + ")"); emit(p); }
  }
  function markStopped(p, why) {
    const c = C(p);
    if (c.stopped) return;
    c.stopped = true; c.stoppedAt = now(); c.stoppedReason = why; dirty = true;
    log("keepgoing: " + p + " STOPPED - nobody blocked it: " + why + " (marked for Iddo, no more nudges until a new message or progress)");
    emit(p);
  }

  // ---- fleet throttle (cached, tolerant)
  let thr = { at: 0, v: null };
  function throttle() {
    const t = now();
    if (t - thr.at < 60 * 1000) return thr.v;
    thr.at = t;
    try { const s = deps.readThrottle ? deps.readThrottle() : null; thr.v = s ? String(s).toUpperCase() : null; } catch (e) { thr.v = null; }
    return thr.v;
  }

  function evaluate(p) {
    if (!P.globalEnabled) return;
    const r = R(p);
    if (r.inflight) return;
    if (P.agents[p] && P.agents[p].enabled === false) return; // this agent is switched off: nothing to track
    // working agents cost nothing here: activity comes from the existing incremental transcript summary, no tail read
    let working = false;
    try { working = !!deps.isWorking(p); } catch (e) {}
    if (working) { if (P.counters[p] && P.counters[p].stopped) clearStopped(p, "agent is working again"); return; }
    const tail = deps.readTail(p);
    if (!tail) return;
    if (tail.sig === r.lastSig && !r.deferred) return;
    r.deferred = false;
    const t = now();
    const parsed = K.parseTail(tail.text, tail.partialFirst);
    const c = C(p);
    const h = parsed.lastHuman;
    // counters: a new human message (not one this app sent) resets everything; progress after a nudge resets the streak
    if (h && !h.systemish && h.ts > c.humanTs) {
      c.humanTs = h.ts; c.consecutive = 0; c.hashes = []; dirty = true;
      clearStopped(p, "new message from a person");
    } else if (h && h.isNudge && parsed.turnToolUses > 0 && c.consecutive > 0) {
      c.consecutive = 0; dirty = true;
      clearStopped(p, "progress after a nudge");
      log("keepgoing: " + p + " made progress after the nudge (" + parsed.turnToolUses + " tool call(s)) - streak reset");
    }
    const m = P.mission[p];
    if (m && m.active) {
      if (t - (m.since || 0) > L.missionMaxAgeMs) { m.active = false; dirty = true; }
      else if (h && h.isResume && parsed.turnToolUses > 0 && !m.firstTurnDone) { m.firstTurnDone = true; dirty = true; log("keepgoing: " + p + " started working after the handoff"); }
    }
    const base = { now: t, enabled: true, paused: !!(deps.isPaused && deps.isPaused(p)), working, halt: null, parsed, throttle: throttle(), mission: P.mission[p] || null };
    let d = K.decide(base);
    if (d.verdict === "nudge") { // only now pay for the halt check (rate limit / auth / server error own their own recovery)
      let halt = null;
      try { halt = deps.getHalt ? deps.getHalt(p) : null; } catch (e) {}
      if (halt) d = K.decide(Object.assign({}, base, { halt }));
    }
    if (d.defer) r.deferred = true;
    if (d.verdict === "done" || d.verdict === "blocked") {
      if (m && m.active) { m.active = false; dirty = true; }
      log("keepgoing: " + p + " - no nudge, " + d.verdict + ": " + d.reason);
    }
    if (d.verdict !== "nudge") { if (!r.deferred) r.lastSig = tail.sig; if (dirty) save(); return; }

    // a nudge is warranted; the rails
    const text = parsed.last.text;
    const hash = K.hashText(text);
    if (c.hashes.indexOf(hash) !== -1) { log("keepgoing: " + p + " - not nudging again for the same message"); r.lastSig = tail.sig; if (dirty) save(); return; }
    if (c.stopped) { r.lastSig = tail.sig; if (dirty) save(); return; }
    c.recent = (c.recent || []).filter((x) => t - x < L.windowMs);
    if (c.consecutive >= L.maxConsecutive) { markStopped(p, c.consecutive + " nudges in a row did not help"); r.lastSig = tail.sig; save(); return; }
    if (c.recent.length >= L.maxPerWindow) { markStopped(p, c.recent.length + " nudges in " + Math.round(L.windowMs / 3600000) + " h"); r.lastSig = tail.sig; save(); return; }
    if (t - (c.lastNudgeAt || 0) < L.minGapMs || t - lastGlobalNudgeAt < L.globalGapMs) { r.deferred = true; if (dirty) save(); return; }

    c.consecutive++; c.lastNudgeAt = t; c.hashes.push(hash); c.hashes = c.hashes.slice(-10); c.recent.push(t);
    lastGlobalNudgeAt = t; r.lastSig = tail.sig; r.inflight = true; save();
    log("keepgoing: NUDGE #" + c.consecutive + " to " + p + " - " + d.reason);
    emit(p);
    Promise.resolve()
      .then(() => deps.deliver(p, K.NUDGE_TEXT))
      .then((res) => log("keepgoing: nudge to " + p + (res && res.delivered ? " delivered via " + res.via : " NOT confirmed in the transcript (" + ((res && res.attempts) || 0) + " attempts)")))
      .catch((e) => log("keepgoing: nudge delivery to " + p + " failed: " + (e && e.message)))
      .then(() => { r.inflight = false; });
  }

  function tick() {
    let paths = [];
    try { paths = deps.agents() || []; } catch (e) { return; }
    for (const p of paths) {
      try { evaluate(p); } catch (e) { log("keepgoing: evaluate " + p + " failed: " + (e && e.message)); }
    }
    if (dirty) save();
  }

  // ---- settings / state for the UI
  function setEnabled(p, enabled) {
    if (p == null) { P.globalEnabled = !!enabled; log("keepgoing: ALL agents " + (enabled ? "ON" : "OFF")); }
    else {
      if (enabled) delete P.agents[p]; else P.agents[p] = { enabled: false };
      log("keepgoing: " + p + " " + (enabled ? "ON" : "OFF"));
      if (!enabled) clearStopped(p, "switched off");
    }
    save();
    if (p == null) for (const a of Object.keys(P.counters)) emit(a); else emit(p);
    return getSettings();
  }
  function getSettings() {
    return { globalEnabled: P.globalEnabled, disabled: Object.keys(P.agents).filter((k) => P.agents[k].enabled === false),
      stopped: Object.keys(P.counters).filter((k) => P.counters[k].stopped).map(snap) };
  }

  // ---- across a handoff: the text the fresh session gets (+ the persisted mission marker)
  function resumeText(p, archivedPath) {
    let info = null;
    try { info = K.parseHandoff(deps.readFile ? deps.readFile(archivedPath) : ""); } catch (e) { info = null; }
    const mission = !!(info && info.mission) && enabledFor(p);
    if (mission) {
      P.mission[p] = { active: true, since: now(), path: archivedPath, firstTurnDone: false, nextStep: (info.nextStep || "").slice(0, 300) };
      log("keepgoing: mission marker set for " + p + " (handoff has open work and does not declare BLOCKED)");
    } else {
      if (P.mission[p]) P.mission[p].active = false;
      log("keepgoing: no mission after handoff for " + p + (info && info.blocked ? " (handoff declares BLOCKED)" : info && !info.mission ? " (no open work in the handoff)" : ""));
    }
    save(); emit(p);
    return { text: K.resumePromptText(archivedPath, { mission }), mission };
  }

  return { tick, setEnabled, getSettings, resumeText, snapshot: snap, _state: () => P };
}

module.exports = { create };

// v1.69.0: main-process half of "Keep going" (decision logic: src/keepGoing.js). Event-light: it rides on the existing
// 30 s halted-turn tick, reads a transcript tail ONLY when an agent's transcript changed since the last look (stat
// signature), and reads the fleet throttle file at most once a minute. All I/O is injected, so it is unit-tested
// (tests/keepGoingGlue.test.js) without Electron.
//
// Safety rails (all enforced here, all logged): at most 3 consecutive nudges per agent without a new human message or
// real progress (tool calls after a nudge), 90 s between nudges, never the same message twice, a 10-per-2h ceiling
// even with progress, 20 s between any two nudges fleet-wide, a global and a per-agent switch (persisted).
// After the cap the agent is marked "stopped - nobody blocked it" (state "stopped", an amber needs-attention state).
// v1.74.0 relentless mode ("keep working regardless", per agent or fleet, persisted): other verdicts become next-project nudges,
// higher ceilings (K.LIMITS_RELENTLESS), HOLD and the usage hard stop (deps.usageHardStop) still win, the last 20 decisions per
// agent are kept (persisted, only when they change) so the UI can say why an agent is idle.
"use strict";
const K = require("./keepGoing");

function create(deps) {
  const L = Object.assign({}, K.LIMITS, deps.limits || {});
  const LR = Object.assign({}, K.LIMITS_RELENTLESS, deps.limits || {});
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const store = deps.storage || { load: () => ({}), save: () => {} };

  let P = {};
  try { P = store.load() || {}; } catch (e) { P = {}; }
  if (typeof P.globalEnabled !== "boolean") P.globalEnabled = true;
  P.agents = P.agents || {};     // path -> { enabled: false }   (only overrides are stored)
  P.mission = P.mission || {};   // path -> { active, since, path, firstTurnDone }
  P.counters = P.counters || {}; // path -> { consecutive, lastNudgeAt, hashes[], recent[], humanTs, stopped, stoppedAt, stoppedReason, nothingLeft? }
  if (!P.relentless || typeof P.relentless !== "object") P.relentless = {};  // v1.74.0 (old files have none)
  P.relentless.fleet = P.relentless.fleet === true;
  if (!P.relentless.agents || typeof P.relentless.agents !== "object") P.relentless.agents = {}; // path -> true
  P.decisions = P.decisions || {}; // path -> last DECISIONS_KEPT [{at, verdict, reason, kind}] (only changes are stored)
  const DECISIONS_KEPT = 20;
  const rt = new Map();          // path -> { lastSig, deferred, inflight }
  let lastGlobalNudgeAt = 0;
  const bornAt = now();
  // L3: forget agents that have not been seen for 30 days (keeps keepgoing.json small)
  (function prune() {
    const cut = now() - 30 * 24 * 3600 * 1000;
    for (const k of Object.keys(P.counters)) {
      const c = P.counters[k];
      if (!c.stopped && Math.max(c.lastNudgeAt || 0, c.humanTs || 0, c.stoppedAt || 0) < cut) delete P.counters[k];
    }
    for (const k of Object.keys(P.mission)) if (!(P.mission[k] && P.mission[k].since > cut)) delete P.mission[k];
    for (const k of Object.keys(P.decisions)) {
      const d = P.decisions[k];
      if (!Array.isArray(d) || !d.length || d[d.length - 1].at < cut) delete P.decisions[k]; else if (d.length > DECISIONS_KEPT) P.decisions[k] = d.slice(-DECISIONS_KEPT);
    }
  })();
  let dirty = false;

  function save() { dirty = false; try { store.save(P); } catch (e) { log("keepgoing: could not persist settings: " + e.message); } }
  function R(p) { let r = rt.get(p); if (!r) { r = { lastSig: null, deferred: false, inflight: false }; rt.set(p, r); } return r; }
  function C(p) {
    let c = P.counters[p];
    if (!c) c = P.counters[p] = { consecutive: 0, lastNudgeAt: 0, hashes: [], recent: [], humanTs: 0, stopped: false, stoppedAt: 0, stoppedReason: "" };
    return c;
  }
  // v1.74.0: an order "keep working regardless" (fleet or this agent) implies keep-going for the agent, whatever the old switches say
  function relentlessFor(p) { return P.relentless.fleet === true || P.relentless.agents[p] === true; }
  function enabledFor(p) { return relentlessFor(p) || (P.globalEnabled && !(P.agents[p] && P.agents[p].enabled === false)); }
  function snap(p) {
    const c = P.counters[p] || {};
    const dec = P.decisions[p] || [];
    return { agentPath: p, state: c.stopped ? "stopped" : "ok", enabled: enabledFor(p), agentEnabled: !(P.agents[p] && P.agents[p].enabled === false),
      globalEnabled: P.globalEnabled, consecutive: c.consecutive || 0, since: c.stoppedAt || 0, reason: c.stoppedReason || "",
      mission: !!(P.mission[p] && P.mission[p].active),
      relentless: relentlessFor(p), agentRelentless: P.relentless.agents[p] === true, fleetRelentless: P.relentless.fleet === true,
      outOfProjects: !!(c.nothingLeft), outOfProjectsReason: c.nothingLeft ? c.nothingLeft.reason : "",
      // v1.74.4: a decision made before this app start is stale (it showed "fleet throttle is HOLD" long after the HOLD was gone):
      // not shown as the current reason. `attached` = the app has a terminal on this agent (agents it cannot reach are never judged);
      // `deliveryFailed` = the last nudge was typed but never reached the transcript (dead terminal: Session > Restart Session).
      why: dec.length && dec[dec.length - 1].at >= bornAt ? dec[dec.length - 1] : null, decisions: dec.slice(),
      attached: (() => { try { return (deps.agents() || []).includes(p); } catch (e) { return true; } })(),
      deliveryFailed: !!(R(p).failures > 0) };
  }
  // keep the last DECISIONS_KEPT decisions; an unchanged decision is not stored again (small file). Returns true when stored.
  function record(p, verdict, reason, kind) {
    const d = P.decisions[p] || (P.decisions[p] = []);
    const rs = String(reason || "").slice(0, 160), kd = kind || null;
    const last = d[d.length - 1];
    if (last && last.verdict === verdict && last.reason === rs && last.kind === kd) return false;
    d.push({ at: now(), verdict, reason: rs, kind: kd });
    if (d.length > DECISIONS_KEPT) d.splice(0, d.length - DECISIONS_KEPT);
    dirty = true;
    return true;
  }
  function emit(p) { try { deps.emit && deps.emit(p, snap(p)); } catch (e) { /* never break the tick */ } }
  function clearNothingLeft(p) {
    const c = P.counters[p];
    if (c && c.nothingLeft) { delete c.nothingLeft; dirty = true; emit(p); }
  }
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

  // v1.74.0: the usage hard stop (7d or 5h >= 95%), cached like the throttle; main supplies deps.usageHardStop (fail-open: false)
  let hs = { at: 0, v: false };
  function hardStop() {
    const t = now();
    if (t - hs.at < 60 * 1000) return hs.v;
    hs.at = t;
    try { hs.v = !!(deps.usageHardStop && deps.usageHardStop()); } catch (e) { hs.v = false; }
    return hs.v;
  }

  function evaluate(p) {
    const rel = relentlessFor(p);
    const Lx = rel ? LR : L;
    if (!rel && !P.globalEnabled) return;
    const r = R(p);
    if (r.inflight) return;
    if (!rel && P.agents[p] && P.agents[p].enabled === false) return; // this agent is switched off: nothing to track
    // L5: after an app start every idle agent looks "stopped"; wait a few minutes before judging anybody
    if (Lx.warmupMs > 0 && now() - bornAt < Lx.warmupMs) return;
    // M4: a handoff flow is running for this agent (the renderer tells main): the handoff prompt / resume own the conversation
    try { if (deps.handoffActive && deps.handoffActive(p)) { r.deferred = true; return; } } catch (e) {}
    // working agents cost nothing here: activity comes from the existing incremental transcript summary, no tail read
    let working = false;
    try { working = !!deps.isWorking(p); } catch (e) {}
    if (working) { if (P.counters[p] && P.counters[p].stopped) clearStopped(p, "agent is working again"); if (P.counters[p] && P.counters[p].nothingLeft) clearNothingLeft(p); return; }
    // the key the last judgement was made under: a change of throttle / usage stop / mode re-judges an unchanged transcript
    const hsNow = hardStop();
    const thrNow = throttle() + (rel ? "|R" : "") + (hsNow ? "|H" : "");
    // M5: cheap stat-based signature first; the 128 KB tail is read only when the transcript changed (or a re-check is due)
    let sigNow = null;
    try { sigNow = deps.sig ? deps.sig(p) : null; } catch (e) {}
    if (sigNow != null && sigNow === r.lastSig && !r.deferred && r.thr === thrNow) return;
    const tail = deps.readTail(p);
    if (!tail) return;
    if (tail.sig === r.lastSig && !r.deferred && r.thr === thrNow) return;
    r.deferred = false;
    const t = now();
    const done = () => { r.lastSig = tail.sig; r.thr = thrNow; };
    const parsed = K.parseTail(tail.text, tail.partialFirst);
    const c = C(p);
    const h = parsed.lastHuman;
    // counters: a GENUINE person's new message (origin human; not this app's, not a task notification / hook / relay) resets everything;
    // real work (a non-read tool call) after a nudge resets the streak
    if (h && !h.systemish && h.ts > c.humanTs) {
      c.humanTs = h.ts; c.consecutive = 0; c.hashes = []; r.failures = 0; dirty = true;
      clearStopped(p, "new message from a person"); clearNothingLeft(p);
    } else if (h && h.isNudge && parsed.workToolUses > 0 && c.consecutive > 0) {
      c.consecutive = 0; dirty = true;
      clearStopped(p, "progress after a nudge");
      log("keepgoing: " + p + " made progress after the nudge (" + parsed.workToolUses + " work tool call(s)) - streak reset");
    }
    // a nudge whose delivery was reported "not confirmed" landed late after all: count it, never send a second copy
    if (r.failures > 0 && h && h.isNudge && h.ts >= (r.lastTryAt || 0) - 1000) {
      r.failures = 0; r.retryAfter = 0;
      c.consecutive = (c.consecutive || 0) + 1; c.lastNudgeAt = h.ts; c.hashes.push(K.hashText(r.lastTryText || "")); c.hashes = c.hashes.slice(-10); c.recent.push(h.ts); dirty = true;
      log("keepgoing: the nudge to " + p + " landed late - counted, not retried");
    }
    const m = P.mission[p];
    if (m && m.active) {
      if (t - (m.since || 0) > L.missionMaxAgeMs) { m.active = false; dirty = true; }
      else if (h && h.isResume && parsed.workToolUses > 0 && !m.firstTurnDone) { m.firstTurnDone = true; dirty = true; log("keepgoing: " + p + " started working after the handoff"); }
    }
    const base = { now: t, enabled: true, paused: !!(deps.isPaused && deps.isPaused(p)), working, halt: null, parsed, throttle: thr.v, mission: P.mission[p] || null, relentless: rel, usageHardStop: hsNow };
    let d = K.decide(base);
    if (d.verdict === "nudge") { // only now pay for the halt check (rate limit / auth / server error own their own recovery)
      let halt = null;
      try { halt = deps.getHalt ? deps.getHalt(p) : null; } catch (e) {}
      if (halt) d = K.decide(Object.assign({}, base, { halt }));
    }
    if (d.defer) r.deferred = true;
    if (record(p, d.verdict, d.reason, d.kind)) emit(p);
    if (d.verdict === "done" && /^NOTHING-LEFT/.test(d.reason)) { // v1.74.0: the agent says it ran out of projects: a real stop, shown as such
      const c0 = C(p);
      if (!c0.nothingLeft) { c0.nothingLeft = { at: t, reason: d.reason.slice(0, 200) }; dirty = true; log("keepgoing: " + p + " is out of projects - " + d.reason); emit(p); }
    }
    const isHold = d.verdict === "blocked" && /throttle is HOLD|usage hard stop|CPU guard hold/.test(d.reason);
    if (d.verdict === "done" || d.verdict === "blocked") {
      if (!isHold && m && m.active) { m.active = false; dirty = true; }
      const hk = K.hashText(parsed.last && parsed.last.text) + d.reason;
      if (!isHold || r.holdLogged !== hk) { log("keepgoing: " + p + " - no nudge, " + d.verdict + ": " + d.reason); if (isHold) r.holdLogged = hk; }
    }
    // H2: the signature is remembered together with the throttle value it was judged under, so an unchanged transcript is
    // judged again the moment the throttle leaves HOLD
    if (d.verdict !== "nudge") { if (!r.deferred) done(); if (dirty) save(); return; }

    // a nudge is warranted; the rails
    const text = parsed.last.text;
    const hash = K.hashText(text);
    if (c.hashes.indexOf(hash) !== -1) { log("keepgoing: " + p + " - not nudging again for the same message"); done(); if (dirty) save(); return; }
    if (c.stopped) { done(); if (dirty) save(); return; }
    c.recent = (c.recent || []).filter((x) => t - x < Lx.windowMs);
    if (c.consecutive >= Lx.maxConsecutive) { markStopped(p, c.consecutive + " nudges in a row did not help"); record(p, "none", "stopped: " + c.consecutive + " nudges in a row did not help"); done(); save(); return; }
    if (c.recent.length >= Lx.maxPerWindow) { markStopped(p, c.recent.length + " nudges in " + Math.round(Lx.windowMs / 3600000) + " h"); record(p, "none", "stopped: " + c.recent.length + " nudges in " + Math.round(Lx.windowMs / 3600000) + " h"); done(); save(); return; }
    if (t < (r.retryAfter || 0) || t - (c.lastNudgeAt || 0) < Lx.minGapMs || t - lastGlobalNudgeAt < Lx.globalGapMs) { r.deferred = true; if (dirty) save(); return; }

    const prev = { consecutive: c.consecutive, lastNudgeAt: c.lastNudgeAt, hashes: c.hashes.slice() };
    c.consecutive++; c.lastNudgeAt = t; c.hashes.push(hash); c.hashes = c.hashes.slice(-10); c.recent.push(t);
    lastGlobalNudgeAt = t; done(); r.inflight = true; r.lastTryAt = t; r.lastTryText = text; save();
    log("keepgoing: NUDGE #" + c.consecutive + " to " + p + " - " + d.reason);
    emit(p);
    Promise.resolve()
      .then(() => deps.deliver(p, d.kind === "next-project" ? (d.question ? K.NEXT_PROJECT_QUESTION_TEXT : K.NEXT_PROJECT_TEXT) : K.NUDGE_TEXT))
      .catch((e) => { log("keepgoing: nudge delivery to " + p + " failed: " + (e && e.message)); return { delivered: false, attempts: 0, error: true }; })
      .then((res) => {
        if (res && res.delivered) { r.failures = 0; log("keepgoing: nudge to " + p + " delivered via " + res.via); return; }
        if (res && res.dry) { log("keepgoing: nudge to " + p + " not delivered (dry run)"); return; }
        // M1: a nudge that never landed does not count: undo it, retry later (twice), then tell Iddo
        if (res && res.aborted) { // a handoff started meanwhile: not a delivery failure, nothing to retry on a timer
          c.consecutive = prev.consecutive; c.lastNudgeAt = prev.lastNudgeAt; c.hashes = prev.hashes; c.recent.pop(); dirty = true; r.deferred = true; save();
          log("keepgoing: nudge to " + p + " cancelled (a handoff started) - not counted as a failure");
          return;
        }
        r.failures = (r.failures || 0) + 1;
        emit(p);
        log("keepgoing: nudge to " + p + " NOT confirmed in the transcript (" + ((res && res.attempts) || 0) + " attempts), failure " + r.failures);
        c.consecutive = prev.consecutive; c.lastNudgeAt = prev.lastNudgeAt; c.hashes = prev.hashes; c.recent.pop(); dirty = true;
        if (r.failures >= 3) { markStopped(p, "the nudge could not be delivered (3 attempts)"); r.failures = 0; }
        else { r.retryAfter = now() + L.retryAfterMs; r.deferred = true; }
        save();
      })
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
  // v1.74.0: null = the fleet switch. Relentless implies keep-going for the agent; turning it on also lifts an old "stopped" mark.
  function setRelentless(p, on) {
    if (p == null) { P.relentless.fleet = !!on; log("keepgoing: RELENTLESS (keep working regardless) for ALL agents " + (on ? "ON" : "OFF")); }
    else {
      if (on) P.relentless.agents[p] = true; else delete P.relentless.agents[p];
      log("keepgoing: RELENTLESS (keep working regardless) for " + p + " " + (on ? "ON" : "OFF"));
      if (on) { clearStopped(p, "relentless mode switched on"); clearNothingLeft(p); }
    }
    save();
    if (p == null) { for (const a of new Set([].concat(Object.keys(P.counters), Object.keys(P.decisions), Object.keys(P.relentless.agents)))) emit(a); } else emit(p);
    return getSettings();
  }
  function getSettings() {
    const known = new Set([].concat(Object.keys(P.decisions), Object.keys(P.relentless.agents)));
    for (const k of Object.keys(P.counters)) if (P.counters[k].stopped || P.counters[k].nothingLeft) known.add(k);
    return { globalEnabled: P.globalEnabled, disabled: Object.keys(P.agents).filter((k) => P.agents[k].enabled === false),
      stopped: Object.keys(P.counters).filter((k) => P.counters[k].stopped).map(snap),
      relentless: { fleet: P.relentless.fleet === true, agents: Object.keys(P.relentless.agents).filter((k) => P.relentless.agents[k] === true) },
      agentStates: Array.from(known).map(snap) };
  }

  // ---- across a handoff: the text the fresh session gets (+ the persisted mission marker)
  function resumeText(p, archivedPath) {
    let info = null;
    try { info = K.parseHandoff(deps.readFile ? deps.readFile(archivedPath) : ""); } catch (e) { info = null; }
    const rel = relentlessFor(p);
    const mission = (!!(info && info.mission) || rel) && enabledFor(p);
    if (mission) {
      P.mission[p] = { active: true, since: now(), path: archivedPath, firstTurnDone: false, nextStep: (info.nextStep || "").slice(0, 300) };
      log("keepgoing: mission marker set for " + p + " (handoff has open work and does not declare BLOCKED)");
    } else {
      if (P.mission[p]) P.mission[p].active = false;
      log("keepgoing: no mission after handoff for " + p + (info && info.blocked ? " (handoff declares BLOCKED)" : info && !info.mission ? " (no open work in the handoff)" : ""));
    }
    save(); emit(p);
    return { text: K.resumePromptText(archivedPath, { mission }, rel), mission };
  }

  return { tick, setEnabled, setRelentless, relentlessFor, getSettings, resumeText, snapshot: snap, _state: () => P };
}

module.exports = { create };

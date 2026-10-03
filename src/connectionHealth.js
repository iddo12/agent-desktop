// v1.67.0: connection health - Agent Desktop's link to each agent's pty (the `claude attach` process).
//
// Why this exists (2026-10-03, Video Editing agent): an attach/reattach timed out at 100% CPU
// (`recovery dispatch FAILED ... [attach stage] ... agent timed out`) and the app kept a dead link. Messages
// were written to it and never landed, Resend wrote to the same dead pty, the "Working... NNNNs" timer kept
// counting for an idle agent. Three gaps, three mechanisms here:
//   1. A failed attach/reattach is retried forever with growing backoff (10 s, 20 s ... 5 min), one one-shot
//      timer per DISCONNECTED agent only.
//   2. Dead-link detection: a message written to the pty must show up on its screen (the CLI
//      echoes typed text into its input box). If 30 s pass, the typed text is nowhere on the screen AND the
//      transcript shows an idle agent that has not grown since the write, the link is dead -> restart that agent's session (same as Session > Restart
//      Session, resumes with --continue). Capped at 3 per 15 min per agent; beyond that the state becomes
//      "degraded" and the renderer delivers over the message channel instead.
//   2b. (v1.68.0) Stuck Enter: the text IS on the screen (the live link is fine) but no transcript entry follows -
//      the Enter was swallowed by the paste. After stuckEnterMs the app presses Enter itself, ONCE, then checks
//      again after stuckVerifyMs; if the text is still sitting in the input box and the agent is idle, it falls
//      back to the dead-link recovery (restart + requeue). Never when a prompt is waiting for an answer, never
//      unless the screen shows exactly the text this app typed (so an unsent draft of the user's own is left alone).
//   3. After a stuck-turn recovery (kill + redispatch) interrupted a working agent, one short
//      "carry on" nudge is typed in, at most once per 15 min per agent.
// Everything is event driven (no polling loops): the only timers are one-shots armed by a write, a failure
// or a restart, and cleared as soon as they are not needed. All I/O is injected so this is unit-testable.
"use strict";

const DEFAULTS = {
  deadLinkMs: 30 * 1000,
  backoffBaseMs: 10 * 1000,
  backoffMaxMs: 5 * 60 * 1000,
  restartCap: 3,
  restartWindowMs: 15 * 60 * 1000,
  nudgeMinGapMs: 15 * 60 * 1000,
  nudgeDelayMs: 10 * 1000,
  stuckEnterMs: 8 * 1000,       // text typed, still no transcript entry: press Enter once
  stuckVerifyMs: 6 * 1000,      // ... and look again this much later
  opTimeoutMs: 2 * 60 * 1000,   // a restart / reconnect that hangs (or waits in a start limiter) falls back to backoff
};

const NUDGE_TEXT =
  "[Agent Desktop] Your session was restarted automatically because it stopped responding while you were working. " +
  "Please carry on from where you left off.";

// deps: { now, setTimeout, clearTimeout, log(line), emit(agentPath, snapshot),
//   shouldRetry(agentPath) -> bool            (agent exists, not paused, not a blocked sandbox)
//   sessionKind(agentPath) -> "real"|"starting"|null
//   reconnect(agentPath, size) -> Promise     (find-or-dispatch + attach; throws on failure)
//   restartSession(agentPath) -> Promise      (Restart Session equivalent; throws on failure)
//   screenShows(agentPath, snippet) -> bool   (the CLI's screen contains the typed text = the link is alive)
//   inputHoldsText(agentPath, snippet) -> bool (optional; the text sits UNSENT in the input box, no prompt open)
//   transcriptHas(agentPath, text, sinceMs) -> true|false|null (optional; delivered per the transcript, null = cannot tell)
//   pressEnter(agentPath) -> void              (optional)
//   isIdleAndQuiet(agentPath, sinceMs) -> bool (agent idle per transcript AND transcript not written since sinceMs)
//   isWorking(agentPath) -> bool
//   wasInterrupted(agentPath) -> bool
//   nudge(agentPath, text) -> void }
function create(deps, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const now = deps.now || Date.now;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const log = deps.log || (() => {});
  const agents = new Map();

  function get(p) {
    let a = agents.get(p);
    if (!a) {
      a = { agentPath: p, state: "connected", attempts: 0, timer: null, nextRetryAt: 0, reason: "", since: 0,
            unackedSince: null, deadTimer: null, stuckTimer: null, enterPresses: 0, text: "", restarts: [], lastNudgeAt: 0, requeueSince: null, recovering: false, size: null };
      agents.set(p, a);
    }
    return a;
  }
  function snapshot(a) {
    return { agentPath: a.agentPath, state: a.state, attempts: a.attempts, nextRetryAt: a.nextRetryAt, reason: a.reason,
             since: a.since, requeueSince: a.requeueSince };
  }
  function emit(a) {
    try { deps.emit && deps.emit(a.agentPath, snapshot(a)); } catch (e) { /* never break the caller */ }
  }
  function unref(t) { try { if (t && t.unref) t.unref(); } catch (e) {} return t; }

  function schedule(a) {
    const delay = Math.min(o.backoffMaxMs, o.backoffBaseMs * Math.pow(2, a.attempts));
    a.nextRetryAt = now() + delay;
    clearT(a.timer);
    a.timer = unref(setT(() => attempt(a.agentPath), delay));
  }

  async function attempt(p) {
    const a = get(p);
    a.timer = null;
    let ok;
    try { ok = deps.shouldRetry(p); } catch (e) { ok = false; }
    if (!ok) { log(`connection: ${p} - no longer eligible for reconnect, stopped`); settle(a, true); return; }
    const kind = deps.sessionKind(p);
    if (kind === "real") { onConnected(p); return; }
    if (kind === "starting") { schedule(a); return; } // someone else (a tab open, the sweep) is connecting right now
    try {
      await withTimeout(deps.reconnect(p, a.size), o.opTimeoutMs, "reconnect");
    } catch (e) {
      a.attempts++;
      a.reason = (e && e.message) || String(e);
      log(`connection: ${p} reconnect attempt ${a.attempts} FAILED: ${a.reason} (next in ${Math.round(Math.min(o.backoffMaxMs, o.backoffBaseMs * Math.pow(2, a.attempts)) / 1000)}s)`);
      schedule(a);
      emit(a);
      return;
    }
    onConnected(p);
  }

  function settle(a, silent) {
    clearT(a.timer); a.timer = null;
    clearT(a.deadTimer); a.deadTimer = null;
    a.unackedSince = null;
    a.attempts = 0;
    a.state = "connected";
    if (!silent) emit(a);
  }

  // Called when a session object really exists again (end of startTerminalSession).
  function onConnected(p) {
    const a = agents.get(p);
    if (!a || a.state === "connected") return;
    const was = a.state;
    log(`connection: ${p} connected again (was ${was}, after ${a.attempts} failed attempt(s))`);
    settle(a, false);
    a.requeueSince = null;
    a.reason = "";
  }

  // A failed attach / reattach / recovery dispatch. Returns true when the module took over (the caller should
  // not show a dead-end "session ended" notice).
  function onAttachFailed(p, reason, size) {
    let ok;
    try { ok = deps.shouldRetry(p); } catch (e) { ok = false; }
    if (!ok) return false;
    const a = get(p);
    if (a.recovering) return true;
    if (size) a.size = size;
    a.reason = String(reason || "attach failed").slice(0, 300);
    if (a.state === "connected" || a.state === "degraded") { a.state = "reconnecting"; a.attempts = 0; a.since = now(); }
    if (!a.timer) { log(`connection: ${p} not connected (${a.reason}) - reconnecting with backoff`); schedule(a); }
    emit(a);
    return true;
  }

  // Real message text only: a bracketed-paste start, or >= 3 printable characters once escape sequences are removed.
  function isMessageWrite(data) {
    if (typeof data !== "string") return false;
    if (data.indexOf("\u001b[200~") === 0) return data.length > 6;
    const plain = data.replace(/\u001b\[[0-9;?<>]*[A-Za-z~]/g, "").replace(/\u001b[O]?[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
    return plain.length >= 3;
  }

  function noteWrite(p, data) {
    if (!isMessageWrite(data)) return; // keystrokes, arrow keys, focus/mouse reports are not messages (review H2)
    const a = get(p);
    if ((a.state !== "connected" && a.state !== "degraded") || a.unackedSince != null) return;
    a.unackedSince = now();
    a.text = String(data).replace(/^\u001b\[200~/, "").slice(0, 4000);
    a.snippet = String(data).replace(/^\u001b\[200~/, "").slice(-40);
    a.enterPresses = 0;
    a.deadTimer = unref(setT(() => checkDead(p), o.deadLinkMs));
    if (deps.inputHoldsText && deps.pressEnter) { clearT(a.stuckTimer); a.stuckTimer = unref(setT(() => checkStuck(p), o.stuckEnterMs)); }
  }

  function ackState(p, a) {
    try { return deps.transcriptHas ? deps.transcriptHas(p, a.text, a.unackedSince) : null; } catch (e) { return null; }
  }
  function holds(p, a) {
    try { return !!deps.inputHoldsText(p, a.snippet); } catch (e) { return false; }
  }

  // stuckEnterMs after a message write: still no transcript entry and the text sits in the input box -> Enter, once.
  function checkStuck(p) {
    const a = get(p);
    a.stuckTimer = null;
    if (a.unackedSince == null || (a.state !== "connected" && a.state !== "degraded")) return;
    if (ackState(p, a) === true) return;                 // it landed
    if (!holds(p, a)) return;                            // not in the box: the dead-link check (or the renderer) decides
    if (a.enterPresses >= 1) return;
    a.enterPresses++;
    log(`stuck-enter: ${p} - the typed text sits in the input box ${Math.round(o.stuckEnterMs / 1000)}s after the write with no transcript entry; pressing Enter once`);
    try { deps.pressEnter(p); } catch (e) { log(`stuck-enter: ${p} pressEnter failed: ${e.message}`); return; }
    a.stuckTimer = unref(setT(() => verifyStuck(p), o.stuckVerifyMs));
  }

  function verifyStuck(p) {
    const a = get(p);
    a.stuckTimer = null;
    if (a.unackedSince == null || (a.state !== "connected" && a.state !== "degraded")) return;
    const ack = ackState(p, a);
    if (ack === true) { log(`stuck-enter: ${p} - delivered after the automatic Enter`); return; }
    if (ack === null) return;                            // cannot verify (very short text): one Enter was all we do
    if (!holds(p, a)) return;                            // left the box (submitted or cleared): the receipt may just be late
    let working = false;
    try { working = !!(deps.isWorking && deps.isWorking(p)); } catch (e) {}
    if (working) { log(`stuck-enter: ${p} - text still in the input box after Enter but the agent is working; leaving it to the Not-confirmed notice`); return; }
    log(`stuck-enter: ${p} - still in the input box after the automatic Enter; recovering the link`);
    recover(p, "stuck Enter: the message text stays in the input box after an automatic Enter");
  }

  // Kept as a cheap hook: an idle CLI redraws its status line now and then, so "any output" proves nothing.
  // The dead-link test looks at the screen for the typed text instead (see checkDead).
  function noteData(p) {
    const a = agents.get(p);
    if (a && a.state === "degraded" && a.unackedSince == null) { /* nothing to do */ }
  }

  function checkDead(p) {
    const a = get(p);
    a.deadTimer = null;
    const since = a.unackedSince;
    if (since == null || (a.state !== "connected" && a.state !== "degraded")) return;
    let quiet = false;
    try { quiet = !!deps.isIdleAndQuiet(p, since); } catch (e) { quiet = false; }
    if (!quiet) { a.unackedSince = null; return; } // the agent is working or wrote since: not a dead link
    let shown = false;
    try { shown = !!(deps.screenShows && deps.screenShows(p, a.snippet)); } catch (e) {}
    if (shown) { a.unackedSince = null; return; } // the CLI echoed the text: live link. A stuck Enter was handled at +8 s / +14 s by checkStuck()/verifyStuck() (v1.68.0)
    recover(p, `no output from the agent's pty for ${Math.round(o.deadLinkMs / 1000)}s after a message was written, and the agent is idle with nothing new in its transcript`);
  }

  function withTimeout(promise, ms, what) {
    let t;
    const timeout = new Promise((_, rej) => { t = setT(() => rej(new Error(what + " timed out after " + Math.round(ms / 1000) + "s")), ms); unref(t); });
    return Promise.race([promise, timeout]).finally(() => clearT(t));
  }

  async function recover(p, reason) {
    const a = get(p);
    if (a.recovering) return;
    // review M4: only restart a session that really exists; a "starting" placeholder belongs to a stuck-turn recovery,
    // a tab open or the sweep (a second dispatch for the same folder would make a duplicate agent copy)
    let kind = null;
    try { kind = deps.sessionKind(p); } catch (e) {}
    if (kind !== "real") { a.unackedSince = null; log(`connection: ${p} dead-link restart skipped (session is ${kind || "absent"}, something else is connecting)`); return; }
    const t = now();
    a.restarts = a.restarts.filter((x) => t - x < o.restartWindowMs);
    a.requeueSince = a.unackedSince;
    a.unackedSince = null;
    clearT(a.stuckTimer); a.stuckTimer = null;
    if (a.restarts.length >= o.restartCap) {
      a.state = "degraded";
      a.since = t;
      a.reason = `dead link, but ${o.restartCap} automatic restarts already happened in ${Math.round(o.restartWindowMs / 60000)} min - not restarting again`;
      log(`connection: ${p} DEGRADED: ${a.reason}`);
      emit(a);
      return;
    }
    a.restarts.push(t);
    a.recovering = true;
    a.state = "restarting";
    a.since = t;
    a.reason = reason;
    log(`connection: ${p} DEAD LINK - ${reason}. Restarting its session (#${a.restarts.length} in the last ${Math.round(o.restartWindowMs / 60000)} min)`);
    emit(a);
    try {
      await withTimeout(deps.restartSession(p), o.opTimeoutMs, "session restart");
      a.recovering = false;
      log(`connection: ${p} session restarted OK`);
      onConnected(p);
    } catch (e) {
      a.recovering = false;
      a.reason = (e && e.message) || String(e);
      log(`connection: ${p} restart FAILED: ${a.reason} - falling back to reconnect with backoff`);
      a.state = "reconnecting";
      a.attempts = 0;
      schedule(a);
      emit(a);
    }
  }

  // After a stuck-turn recovery (kill + redispatch) succeeded: type one "carry on" nudge if the agent was
  // working when it was cut off, once per nudgeMinGapMs, and only if it is idle at its prompt by then.
  function afterStuckRecovery(p, info) {
    const a = get(p);
    const t = now();
    if (t - a.lastNudgeAt < o.nudgeMinGapMs) { log(`connection: ${p} nudge skipped (one already sent ${Math.round((t - a.lastNudgeAt) / 1000)}s ago)`); return false; }
    let interrupted = false;
    try { interrupted = !!deps.wasInterrupted(p); } catch (e) {}
    if (!(interrupted || (info && info.wasWorking))) return false;
    a.lastNudgeAt = t;
    setT(() => {
      let busy = false;
      try { busy = !!deps.isWorking(p); } catch (e) {}
      if (busy || deps.sessionKind(p) !== "real") { log(`connection: ${p} nudge not needed (agent already working or not attached)`); return; }
      log(`connection: ${p} sent the "carry on" nudge after recovery`);
      try { deps.nudge(p, NUDGE_TEXT); } catch (e) { log(`connection: ${p} nudge failed: ${e.message}`); }
    }, o.nudgeDelayMs);
    return true;
  }

  function getState(p) { const a = agents.get(p); return a ? snapshot(a) : { agentPath: p, state: "connected" }; }
  function getAll() { return Array.from(agents.values()).filter((a) => a.state !== "connected").map(snapshot); }
  function forget(p) { const a = agents.get(p); if (a) { clearT(a.timer); clearT(a.deadTimer); clearT(a.stuckTimer); agents.delete(p); } }

  return { onAttachFailed, onConnected, noteWrite, noteData, afterStuckRecovery, getState, getAll, forget, _recover: recover, NUDGE_TEXT };
}

module.exports = { create, DEFAULTS, NUDGE_TEXT };

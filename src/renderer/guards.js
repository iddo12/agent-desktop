// Guards (v1.23.0) - loaded AFTER renderer.js, deliberately isolated: everything is
// inside try/catch and only talks to renderer.js through its existing globals
// (activeAgentPath, terminals, submitToAgent, performSessionReset, renderQueue), so a
// bug here can only disable the guards, never the chat.
//
//  1. Context banner: when this agent's live context passes CONTEXT_WARN_TOKENS, offer
//     "Save handoff & reset". Every message re-reads the whole context, so long
//     sessions are the main cost driver (see the Optimization agent's analysis).
//     Approved flow: agent writes lessons to memory + <agent>\handoff_latest.md ->
//     Agent Desktop archives that file -> the normal Reset Session sequence runs ->
//     the new session's first message points at the archived handoff. The Chat View
//     then shows a red "SESSION RESET" marker listing the lessons (see archive.js).
//  2. Limit banner: 80/90/95% and at-the-limit warnings inside the chat (OS
//     notifications for the same thresholds come from guards-main.js).
(function () {
  "use strict";
  const CONTEXT_WARN_TOKENS = 150000;

  // --- automatic handoff (2026-09-22) ---------------------------------------
  // The warning banner at 150K is advisory, and advisory was not enough: the
  // System Optimization agent ran to 246K / 100% context while working, and
  // the first Iddo knew of it was two of his messages failing to arrive. A
  // full agent cannot accept input at all, so by the time it is visible it is
  // already costing him messages.
  //
  // So above AUTO_HANDOFF_TOKENS an idle agent hands itself off. Deliberately
  // set above the warning, not at it: he gets the banner and a chance to act
  // himself first, and automation only steps in when that was ignored and the
  // wall is close.
  //
  // Handoff wipes a conversation, so the guards matter more than the trigger:
  //   - IDLE ONLY. Never interrupt a turn in progress.
  //   - One at a time, fleet-wide, and never while "Handoff all" is running.
  //   - Once per agent per app run, so a misjudgement cannot loop.
  //   - Nothing is lost: the flow saves lessons to memory and writes a
  //     handoff file before resetting, and the old conversation stays in
  //     History.
  // It is switchable from the console for a session where it would be
  // unwelcome: localStorage.setItem("autoHandoffOff","1").
  // 2026-09-28: lowered from 200000. That left zero headroom for the
  // handoff-writing turn itself on a standard 200K context window (this repo
  // has no 1M-context beta configured anywhere) - the turn that saves lessons
  // and writes the handoff file has to run inside whatever's left, and at
  // 200000 there was nothing left to run it in.
  const AUTO_HANDOFF_TOKENS = 155000;
  // 2026-09-28: was 120000. Iddo, after Product Development sat at 400K+
  // tokens all night with auto-handoff never firing: "the agent should check
  // itself every time it basically stops... it's super simple." It already
  // was idle-checked every pass - the real gap was that an agent chaining
  // straight from one backlog task to the next (the "keep working" standing
  // order) can have an idle window only a few seconds wide, and a 120s poll
  // almost never lands inside one. header-tasks.js's own fleet-wide "working
  // now / open, waiting / not running" sidebar status already re-checks
  // every agent's activity every 10s (POLL_MS there) to drive those dots -
  // this just matches that same, already-proven cadence instead of a much
  // slower independent timer, so a real gap is now unlikely to go unseen for
  // more than a few seconds instead of up to two minutes.
  const AUTO_HANDOFF_CHECK_MS = 10000;
  // 2026-10-03: was a once-per-run Set, so a failed/stuck flow was NEVER retried (UI-UX sat at 488K).
  // Now agentPath -> { at, count }: a retry is allowed after a cool-down (10 min, doubling per
  // attempt, capped at 1 h) and only if the agent is idle, still over the line and has no live flow.
  const autoHandedOff = new Map();
  const MAX_AUTO_ATTEMPTS = 3;                   // loop safeguard: at most 3 automatic handoff attempts per agent per run
  const RETRY_BASE_MS = 10 * 60 * 1000;
  const RETRY_MAX_MS = 60 * 60 * 1000;
  const STALE_FLOW_MS = 45 * 60 * 1000;          // a non-failed flow older than this is wedged (timer lost)
  const ATTACH_RETRY_MS = 2 * 60 * 1000;
  const attachFailedAt = new Map();
  // Test aid only: localStorage.setItem("autoHandoffCooldownMs","20000") shortens the cool-down.
  function retryCooldownMs(count) {
    let base = RETRY_BASE_MS, cap = RETRY_MAX_MS;
    try {
      const o = parseInt(localStorage.getItem("autoHandoffCooldownMs") || "", 10);
      if (o > 0) { base = o; cap = o * 6; }
    } catch (e) {}
    return Math.min(base * Math.pow(2, Math.max(0, count - 1)), cap);
  }
  // Every skip / start / failure of the sweep goes to stuck-turn-watchdog.log (main process), at most
  // once per agent+reason per 5 min, so "why did X never hand off" is answerable afterwards.
  const GLOG_EVERY_MS = 5 * 60 * 1000;
  const glogAt = new Map();
  function glog(agentName, reason, line) {
    const key = agentName + "|" + reason;
    const now = Date.now();
    if (now - (glogAt.get(key) || 0) < GLOG_EVERY_MS) return;
    glogAt.set(key, now);
    window.autoHandoffLog(line);
  }
  window.autoHandoffLog = (line) => {              // flow events (start/fail/finish) are not rate-limited
    try { window.api.logGuard(line); } catch (e) {}
    console.log("[guards] auto-handoff:", line);
  };
  let lastEligibleSig = null;

  // 2026-10-02: FORCED CHECKPOINT - the second half of Iddo's design (09-29: "if it doesn't stop
  // for a long time and keeps working... you do need some way of stopping it"). The idle-only
  // check above can never fire for an agent whose work is one long linear turn: the Video
  // Editing Agent went 68K -> 249K tokens in 21 minutes, mid-turn the whole way, and was never
  // idle once. So: over AUTO_HANDOFF_TOKENS and working continuously for FORCE_AFTER_MS, press
  // Esc (interrupt) when - and only when - the transcript shows it is actively writing, then the
  // normal idle path hands it off and resumes it from the handoff file.
  //   - NEVER interrupts a quiet transcript: a turn that has gone quiet is usually sitting on a
  //     permission prompt, and Esc there would answer "No" on Iddo's behalf. It shows a banner
  //     instead.
  //   - Same fleet-wide and once-per-agent guards as the idle path (it only interrupts; the
  //     handoff itself still goes through checkAutoHandoff's normal conditions).
  //   - ON by default since 2026-10-02 (Iddo said yes); the four review findings are fixed below. Off switch: localStorage.setItem("forcedCheckpointOff","1").
  const FORCE_AFTER_MS = 10 * 60 * 1000;     // continuous working time before a forced checkpoint (at AUTO_HANDOFF_TOKENS)
  // 2026-10-03: token-aware - the fuller the context, the sooner we interrupt (agents were reaching 190-250K
  // while waiting out the flat 10 minutes). >=190K: 30 s of work + the confirm polls; >=175K: 2 min; else 10 min.
  function forceAfterMsFor(t) {
    if (t >= 190000) return 30 * 1000;      // floor: a turn Iddo only just started is not Esc'd instantly
    if (t >= 175000) return 2 * 60 * 1000;
    return FORCE_AFTER_MS;
  }
  const FORCE_ACTIVE_QUIET_MS = 15000;       // transcript must have grown within this to count as "actively writing"
  const FORCE_BLOCKED_QUIET_MS = 90000;      // quiet this long while "working" = waiting on something, tell Iddo
  const forcedInterrupts = new Map();        // agentPath -> time of the Esc we sent
  const blockedNoticeAt = new Map();         // agentPath -> last time we showed the waiting banner

  // 2026-10-02: ON by default (Iddo said yes after Software Engineering sat at 683K tokens, never idle,
  // so the idle-only path never fired). The four review findings are fixed in maybeForceCheckpoint.
  // Kill switch: localStorage.setItem("forcedCheckpointOff","1").
  function forcedCheckpointEnabled() {
    try { return localStorage.getItem("forcedCheckpointOff") !== "1"; } catch (e) { return true; }
  }
  const forcePolls = new Map();               // agentPath -> timestamps of qualifying polls
  const FORCE_CONFIRM_POLLS = 2;              // qualifying polls needed ...
  const FORCE_CONFIRM_WINDOW_MS = 60 * 1000;  // ... within this window
  const FORCE_REPEAT_GUARD_MS = 20 * 60 * 1000; // never Esc the same agent again within this long
  // 2026-10-03: an agent that is nearly full and STILL working after our Esc (a queued message started a new turn,
  // see parkQueue below) must not wait 20 min for the next one - Software Engineering reached 243K that way.
  function forceRepeatGuardMsFor(t) { return t >= 190000 ? 5 * 60 * 1000 : FORCE_REPEAT_GUARD_MS; }

  // 2026-10-03: PARKED USER QUEUE. Root cause of "never handed off" (Software Engineering, 243K): the agent had
  // user messages waiting in session.sendQueue. After our Esc the turn ended, setBusy(false) drained the queue at
  // once and a NEW turn started before any sweep saw the agent idle; startFlow's idle test also needs an empty
  // queue. So while an Esc/flow is pending the user's queued messages are parked here (a Map, because the reset
  // drops the old session object and its queue with it), then put back at the FRONT of the queue and drained when
  // the flow ends (done/failed/cleared) or the flow never starts. Nothing is dropped or sent twice.
  const parkedQueues = new Map();             // agentPath -> { items: [...], at: ms of last parking }
  const PARK_WAIT_FOR_FLOW_MS = 2 * 60 * 1000; // parked after an Esc but no flow started: give up and restore
  function isFlowOwnMessage(q) { return typeof q === "string" && (q.indexOf("[Agent Desktop") === 0 || q.indexOf(RESUME_MARKER) !== -1 || /^\[hid:[^\]]+\]/.test(q)); }
  // v1.67.1: the held list is written to disk after every change (survives an app restart) and shown in the chat.
  function persistHeld() {
    try { window.api.heldSave(window.HandoffLogic.serializeHeld(parkedQueues)); } catch (e) { /* never break the chat */ }
  }
  function parkQueue(ap, why) {
    const se = terminals.get(ap);
    if (!se || !se.sendQueue || !se.sendQueue.length) return 0;
    const mine = [], keep = [];
    for (const q of se.sendQueue) (isFlowOwnMessage(q) ? keep : mine).push(q);
    if (!mine.length) return 0;
    se.sendQueue.length = 0;
    for (const q of keep) se.sendQueue.push(q);
    const cur = parkedQueues.get(ap);
    parkedQueues.set(ap, { items: (cur ? cur.items : []).concat(mine), at: Date.now() });
    persistHeld();
    try { render(); } catch (e) {}
    try { window.autoHandoffLog("parked " + mine.length + " queued user message(s) for " + agentName(ap) + " (" + why + ")"); } catch (e) {}
    if (typeof renderQueue === "function") renderQueue(ap);
    return mine.length;
  }
  let restoringParked = false;
  async function restoreParkedQueues() {
    if (restoringParked) return;
    restoringParked = true;
    try { await restoreParkedQueuesInner(); } finally { restoringParked = false; }
  }
  async function restoreParkedQueuesInner() {
    for (const [ap, pk] of Array.from(parkedQueues.entries())) {
      try {
        const fl = flows.get(ap);
        if (fl ? (fl.phase === "saving" || fl.phase === "resetting" || fl.phase === "resuming") : Date.now() - pk.at < PARK_WAIT_FOR_FLOW_MS) continue;
        let se = terminals.get(ap);
        if (!se || !se.started) {
          const ag = agents.find((x) => x.path === ap);
          if (ag) { await autoAttachSession(ag); se = terminals.get(ap); }
        }
        if (!se) continue;                      // keep them parked, try again next tick
        // v1.69.1 (H1): a working agent (e.g. the keep-going mission turn after a handoff) gets them mid-turn, like a normal send
        const working = !!(se.started && (se.busy || se.transcriptWorking));
        let dialogOpen = false;
        if (working) { try { dialogOpen = !!(await window.api.agentDialogOpen(ap)); } catch (e) { dialogOpen = true; } }
        const cur = parkedQueues.get(ap);       // v1.69.1 (L2): re-read after the awaits - more may have been parked meanwhile
        if (!cur) continue;
        parkedQueues.delete(ap);
        persistHeld();
        const stillWorking = !!(se.started && (se.busy || se.transcriptWorking));
        const route = window.HandoffLogic.restoreRoute({ working: working && stillWorking, midTurnOk: midTurnAllowed(), dialogOpen, queueLen: se.sendQueue.length, linkHeld: !!(window.connHealth && window.connHealth.holding(ap)) });
        if (route === "midturn" || route === "direct") {
          cur.items.forEach((text, i) => submitToAgent(ap, text, route === "midturn" || i > 0 ? { midTurn: true } : undefined));
          try { window.autoHandoffLog("sent " + cur.items.length + " restored user message(s) to " + agentName(ap) + " (" + route + ")"); } catch (e) {}
          continue;
        }
        pk.items = cur.items;
        se.sendQueue.unshift(...pk.items);      // ahead of anything queued meanwhile: they were sent first
        try { window.autoHandoffLog("restored " + pk.items.length + " parked user message(s) to " + agentName(ap) + " (flow " + (fl ? fl.phase : "never started") + ")"); } catch (e) {}
        if (typeof renderQueue === "function") renderQueue(ap);
        if (se.started && !se.busy && !se.transcriptWorking) setBusy(ap, se, false);   // drain; the idle transition sends the rest one by one
      } catch (e) { console.error("guards restoreParkedQueues", e); }
    }
  }
  window.guardsParkQueue = parkQueue;           // sandbox tests drive these directly
  window.guardsRestoreParked = restoreParkedQueues;
  window.guardsParkedState = () => Array.from(parkedQueues.entries());
  // after an app restart: put back what was held when the app went down (never lose a message typed during a handoff)
  try {
    window.api.heldLoad().then((r) => {
      const m = window.HandoffLogic.parseHeld(r && r.json);
      for (const [ap, v] of m.entries()) {
        const cur = parkedQueues.get(ap);
        parkedQueues.set(ap, { items: v.items.concat(cur ? cur.items : []), at: cur ? cur.at : 0 });
      }
      if (m.size) { try { window.autoHandoffLog("loaded held user messages from disk for " + m.size + " agent(s) after a restart"); } catch (e) {} }
    }).catch(() => {});
  } catch (e) { /* older preload */ }

  async function maybeForceCheckpoint(a, act, t) {
    if (!forcedCheckpointEnabled()) return false;
    if (!act || !act.working || act.sinceMs < forceAfterMsFor(t)) { forcePolls.delete(a.path); return false; }
    // Finding 2: one Esc per agent per FORCE_REPEAT_GUARD_MS (it could repeat every tick).
    const prev = forcedInterrupts.get(a.path);
    if (prev && Date.now() - prev < forceRepeatGuardMsFor(t)) return false;
    const session = terminals.get(a.path);
    if (!session || !session.started) return false;
    const quiet = await window.api.getTranscriptQuietMs(a.path).catch(() => null);
    if (quiet == null) return false;
    if (quiet >= FORCE_BLOCKED_QUIET_MS) {
      forcePolls.delete(a.path);
      const last = blockedNoticeAt.get(a.path) || 0;
      if (Date.now() - last > 30 * 60 * 1000) {
        blockedNoticeAt.set(a.path, Date.now());
        show(ctxBanner, "guard-amber",
          a.displayName + " is at " + Math.round(t / 1000) + "K tokens and has been silent for " + Math.round(quiet / 60000) +
          " min mid-turn - it is probably waiting on a permission prompt, so it was NOT interrupted. Open its tab and answer the prompt.",
          [{ label: "Dismiss", onClick: () => render() }]);
      }
      return false;
    }
    if (quiet > FORCE_ACTIVE_QUIET_MS) { forcePolls.delete(a.path); return false; }   // not clearly active, not clearly stuck - wait
    // Finding 1: a fresh transcript right after an assistant tool_use can be a permission prompt that just
    // appeared (Esc would answer "No" for Iddo). Only count a poll when the newest entry is NOT a pending
    // tool_use (model generating, or a tool result just came back), and require two such polls close together.
    if (act.pendingToolUse) return false;
    // Second review (2026-10-03): `act` predates the awaits above; a tool_use landing meanwhile could be a fresh
    // permission prompt. Re-read activity right before counting the poll.
    const fresh = await window.api.getSessionActivity(a.path).catch(() => null);
    if (!fresh || !fresh.working || fresh.pendingToolUse) { forcePolls.delete(a.path); return false; }
    const now = Date.now();
    const polls = (forcePolls.get(a.path) || []).filter((x) => now - x < FORCE_CONFIRM_WINDOW_MS);
    polls.push(now);
    forcePolls.set(a.path, polls);
    if (polls.length < FORCE_CONFIRM_POLLS) return false;
    forcePolls.delete(a.path);
    forcedInterrupts.set(a.path, now);
    window.api.sendInput(a.path, "");              // Esc: interrupt the running turn
    try { window.autoHandoffLog("forced Esc: " + a.displayName + " " + Math.round(t / 1000) + "K after " + Math.round(act.sinceMs / 1000) + " s continuous work"); } catch (e) {}
    console.log("[guards] forced checkpoint: interrupted", a.displayName, "at", t, "tokens after", Math.round(act.sinceMs / 60000), "min of continuous work");
    return true;
  }

  function autoHandoffEnabled() {
    try {
      return localStorage.getItem("autoHandoffOff") !== "1";
    } catch (e) {
      return true;
    }
  }

  // 2026-09-29: a "failed" flow (handoff didn't finish in 12min, or the resume
  // never confirmed) used to sit in `flows` forever - only a human clicking
  // "Dismiss" on that exact agent's tab removes it. Since checkAutoHandoff
  // below used to gate on flows.size alone, one stuck failed entry on ANY
  // agent silently disabled the automatic sweep for the ENTIRE fleet until
  // someone happened to open that agent and dismiss it, or the app restarted.
  // Confirmed live: Product Development sat idle at 521K tokens, well past
  // AUTO_HANDOFF_TOKENS, and never fired - only an active (not failed) flow
  // should serialize the fleet.
  function fleetFlowInProgress() {
    for (const f of flows.values()) if (f.phase !== "failed") return true;
    return false;
  }

  // 2026-10-03: attach is done by attachSessionInBackground() (renderer.js): it creates the session and
  // starts the pty without selectAgent(), so the visible tab, focus and compose box are never touched
  // and no Iddo-activity gate is needed any more.
  async function autoAttachSession(agent) {
    return await attachSessionInBackground(agent);
  }

  // A failed or wedged flow must neither block its own agent's retry nor sit there forever.
  function agentName(ap) {
    const a = agents.find((x) => x.path === ap);
    return a ? a.displayName : ap;
  }
  function clearFlow(ap, why) {
    const f = flows.get(ap);
    if (f) { try { clearInterval(f.timer); } catch (e) {} flows.delete(ap); }
    pendingResume.delete(ap);
    window.autoHandoffLog("flow cleared for " + agentName(ap) + ": " + why);
    render();
  }
  function reapStaleFlows() {
    const now = Date.now();
    for (const [ap, f] of [...flows.entries()]) {
      if (f.phase === "done" || f.phase === "failed") continue;
      if (now - f.startedAt - (f.pausedMs || 0) > STALE_FLOW_MS) {
        window.autoHandoffLog("flow for " + agentName(ap) + " wedged in phase " + f.phase + " for 45+ min - marked failed");
        f.phase = "failed"; f.error = "Flow wedged for over 45 minutes - cleared automatically.";
        try { clearInterval(f.timer); } catch (e) {}
      }
    }
  }

  // Read-only debug handle (sandbox tests force a failed flow through it).
  window.autoHandoffDebug = () => ({ flows, autoHandedOff, attachFailedAt });

  let autoHandoffRunning = false;
  async function checkAutoHandoff() {
    if (autoHandoffRunning) return;
    autoHandoffRunning = true;
    try { await checkAutoHandoffInner(); } finally { autoHandoffRunning = false; }
  }
  async function checkAutoHandoffInner() {
    if (!autoHandoffEnabled()) return;
    if (allRun && !allRun.finished) return;      // a manual sweep owns the fleet
    reapStaleFlows();
    let activeFlow = null;
    for (const [ap, f] of flows) if (f.phase !== "failed") { activeFlow = ap; break; }
    // Pass 1: who is eligible (>= AUTO_HANDOFF_TOKENS)? Logged whenever the set changes.
    const eligible = [];
    for (const a of agents) {
      try {
        const u = await window.api.getContextUsage(a.path);
        let t = u && typeof u.contextTokens === "number" ? u.contextTokens : 0;
        const raw = t;
        if (t && window.guardUsageIsStale(a.path, u)) t = 0;
        // v1.54.3: re-arm once the agent is back under the warning line (a real, finished reset).
        if (t && t < CONTEXT_WARN_TOKENS) { autoHandedOff.delete(a.path); forcedInterrupts.delete(a.path); attachFailedAt.delete(a.path); }
        nearHandoff.set(a.path, t >= AUTO_HANDOFF_TOKENS);
        if (t >= AUTO_HANDOFF_TOKENS) eligible.push({ a, t });
        else if (raw >= AUTO_HANDOFF_TOKENS) glog(a.displayName, "stale", a.displayName + " " + Math.round(raw / 1000) + "K: skipped, usage predates our last reset (stale)");
      } catch (e) { /* one agent's hiccup must not stop the sweep */ }
    }
    const sig = eligible.map((x) => x.a.displayName).sort().join(",");
    if (sig !== lastEligibleSig) {
      lastEligibleSig = sig;
      window.autoHandoffLog("eligible (>=" + Math.round(AUTO_HANDOFF_TOKENS / 1000) + "K): " + eligible.length + (sig ? " [" + eligible.map((x) => x.a.displayName + " " + Math.round(x.t / 1000) + "K").join(", ") + "]" : ""));
    }
    for (const { a, t } of eligible) {
      const nm = a.displayName, k = Math.round(t / 1000) + "K";
      try {
        const act = await window.api.getSessionActivity(a.path).catch(() => null);
        if (act && act.working) {
          // mid-turn: leave it alone, unless it has been working non-stop long enough to need a forced checkpoint
          glog(nm, "working", nm + " " + k + ": skipped, mid-turn (working " + Math.round((act.sinceMs || 0) / 60000) + " min)");
          await maybeForceCheckpoint(a, act, t);   // finding 4: an Esc for one agent must not starve the others' checks
          continue;
        }
        if (!act) { glog(nm, "noact", nm + " " + k + ": skipped, no activity data"); continue; }
        const prior = autoHandedOff.get(a.path);
        if (prior) {
          const fl = flows.get(a.path);
          if (fl && fl.phase !== "failed") { glog(nm, "inflow", nm + " " + k + ": skipped, its own flow is still running (" + fl.phase + ")"); continue; }
          if (!fl || fl.phase !== "failed") { glog(nm, "notfailed", nm + " " + k + ": skipped, previous flow did not end failed - not re-running"); continue; }
          if (prior.count >= MAX_AUTO_ATTEMPTS) { glog(nm, "cap", nm + " " + k + ": skipped, already tried " + prior.count + " times this run - giving up until it drops under the line"); continue; }
          const wait = retryCooldownMs(prior.count) - (Date.now() - prior.at);
          if (wait > 0) { glog(nm, "cool", nm + " " + k + ": skipped, cooling down after attempt #" + prior.count + ", retry in " + Math.ceil(wait / 1000) + " s"); continue; }
          // cool-down over, agent idle and still over the line: drop the dead flow and try again
          if (fl) clearFlow(a.path, "failed flow, retrying after cool-down");
          window.autoHandoffLog("retry #" + (prior.count + 1) + " for " + nm + " at " + k);
        }
        if (activeFlow && activeFlow !== a.path) { glog(nm, "fleet", nm + " " + k + ": skipped, another handoff is running (" + agentName(activeFlow) + ")"); continue; }
        // An agent whose tab was never opened this run has no pty attached (terminals only gets an
        // entry via showTerminalFor), and a prompt typed into it is silently dropped. Attach it in the
        // background (no tab switch, no focus, no Iddo-activity gate).
        let session = terminals.get(a.path);
        if (!session || !session.started) {
          if (Date.now() - (attachFailedAt.get(a.path) || 0) < ATTACH_RETRY_MS) { glog(nm, "attachwait", nm + " " + k + ": skipped, attach failed recently, waiting"); continue; }
          const ok = await autoAttachSession(a);
          session = terminals.get(a.path);
          if (!ok || !session || !session.started) {
            attachFailedAt.set(a.path, Date.now());
            glog(nm, "attachfail", nm + " " + k + ": skipped, could not attach/start its session");
            continue;
          }
          window.autoHandoffLog("attached session in background for " + nm + " (tab not switched)");
        }
        const count = (prior ? prior.count : 0) + 1;
        autoHandedOff.set(a.path, { at: Date.now(), count });
        window.autoHandoffLog("flow START for " + nm + " at " + k + " (attempt #" + count + ")");
        show(
          ctxBanner,
          "guard-amber",
          nm + " reached " + k + " tokens and was handed off automatically " +
            "(lessons saved to memory first, old conversation kept in History).",
          [{ label: "Dismiss", onClick: () => render() }]
        );
        startFlow(a.path, false);
        return;                                   // only ever one per pass
      } catch (e) {
        window.autoHandoffLog("sweep error for " + nm + ": " + (e && e.message));
      }
    }
  }
  const REDISMISS_GROWTH_TOKENS = 25000;
  const HANDOFF_TIMEOUT_MS = 12 * 60 * 1000;
  const TICK_MS = 10000;
  const FLOW_POLL_MS = 3000;
  const RESUME_MARKER = "[[HANDOFF-RESUME]]";
  const RESUME_SETTLE_MS = 5000; // let a freshly attached session settle before typing into it
  // 2026-09-22: 30s was too short and produced a false failure on a real
  // handoff - the Optimization agent's fresh session was told "the fresh
  // session did not receive the resume message" while it was, in fact,
  // starting up and reading a 5.7 KB handoff file. A brand-new session has to
  // dispatch, attach, load its CLAUDE.md and only then write the message into
  // a transcript file that may not even exist when the first check runs.
  const RESUME_VERIFY_MS = 75000;
  // And never declare failure while the agent is visibly working - the same
  // blind spot that had Agent Desktop telling Iddo to Resend messages that
  // had arrived. A working agent has the message; it is simply busy with it.
  const RESUME_MAX_WAIT_MS = 5 * 60 * 1000;

  // v1.67.1: real handoff durations (seconds, last 5) drive the countdown estimate
  function handoffDurations() { try { return JSON.parse(localStorage.getItem("handoffDurations") || "[]"); } catch (e) { return []; } }
  function recordHandoffDuration(secs) {
    try { localStorage.setItem("handoffDurations", JSON.stringify(handoffDurations().concat([Math.round(secs)]).slice(-5))); } catch (e) {}
  }
  const nearHandoff = new Map(); // agentPath -> over AUTO_HANDOFF_TOKENS at the last sweep (v1.65.0: such agents keep user messages in the app queue so parkQueue can park them before the forced Esc)
  const flows = new Map(); // agentPath -> { phase, startedAt, error, quietPolls }
  const pendingResume = new Map(); // agentPath -> { text, path, readySince, sentAt, tries }
  const dismissedAt = new Map(); // agentPath -> token count when "Later" was clicked
  const resetAt = new Map(); // agentPath -> ms time of our last handoff reset
  // Also used by renderer.js's header "% context" pill (same stale-usage problem).
  window.guardUsageIsStale = (ap, usage) => !!(usage && usage.timestamp && resetAt.has(ap) && new Date(usage.timestamp).getTime() < resetAt.get(ap));
  let ctxTokens = null;

  function el(id, cls) {
    const d = document.createElement("div");
    d.id = id;
    d.className = "guard-banner hidden " + (cls || "");
    return d;
  }

  const chatView = document.getElementById("chat-view");
  const chatBody = document.getElementById("chat-body");
  if (!chatView || !chatBody) return;
  const limitBanner = el("guard-limit-banner");
  const ctxBanner = el("guard-context-banner");
  chatView.insertBefore(limitBanner, chatBody);
  chatView.insertBefore(ctxBanner, chatBody);
  const heldBanner = el("guard-held-banner");   // v1.67.1: messages held until the handoff finishes (visible, never "Not confirmed")
  chatView.insertBefore(heldBanner, chatBody);

  const headerBtn = document.createElement("button");
  headerBtn.id = "handoff-reset-btn";
  headerBtn.textContent = "Handoff & reset";
  headerBtn.title = "A smarter Reset Session: first asks the agent to save its lessons/open items to memory and a handoff file, THEN wipes the conversation and starts fresh from that handoff - so the next session doesn't have to re-learn what this one already figured out. Worth it once a conversation gets long and expensive.";
  const resetBtn = document.getElementById("reset-session-btn");
  if (resetBtn && resetBtn.parentNode) resetBtn.parentNode.insertBefore(headerBtn, resetBtn);
  headerBtn.addEventListener("click", () => startFlow(activeAgentPath, true));

  function handoffPrompt(agentPath) {
    if (window.HandoffLogic) return window.HandoffLogic.handoffPrompt(agentPath.replace(/[\\/]+$/, "") + String.fromCharCode(92) + "handoff_latest.md", { interrupted: forcedInterrupts.has(agentPath) });
    const file = agentPath.replace(/[\\/]+$/, "") + "\\handoff_latest.md";
    return (
      "[Agent Desktop - planned context reset] Iddo approved resetting this session to cut usage. " +
      (forcedInterrupts.has(agentPath)
        ? "Your running turn was interrupted on purpose because the context passed 155K while you were mid-task. In the STATE section say exactly what was in flight and what to verify first (real state of any app or file you were changing: it may be half-applied), then continue it after the reset. "
        : "") +
      "Before it happens, please do ALL of this now, without starting any new work:\n" +
      "1. Compile a 'lessons for the future' list from this session (gotchas + fixes, preferences/decisions Iddo stated, environment quirks) and save each durable one into your memory files per your memory rules.\n" +
      "2. Update your open-items file (OPEN NOW) so it reflects what is still outstanding.\n" +
      "3. Write the file " + file + " with exactly these sections: '# Handoff <date/time>', '## LESSONS' (concise bullets - this section is shown to Iddo), '## OPEN NOW', '## STATE' (what you were in the middle of, key file paths, the exact next step), '## KEY FACTS' (anything else a fresh session needs). Keep it under ~1500 words; write it LAST, after steps 1-2.\n" +
      "4. Reply with only the LESSONS list and the words 'Handoff saved'."
    );
  }

  function resumePrompt(archivedPath) {
    return (
      "[[HANDOFF-RESUME]] " + archivedPath + "\n" +
      "This is a fresh session after a planned context reset. Read that handoff file first, then reply in two short lines: what you are picking up, and your very next step. Continue with that step unless it needs my approval."
    );
  }

  function queueOrSend(agentPath, text) {
    const session = terminals.get(agentPath);
    if (session && (session.busy || !session.started)) {
      session.sendQueue.push(text);
      if (typeof renderQueue === "function") renderQueue(agentPath);
    } else {
      submitToAgent(agentPath, text);
    }
  }

  // v1.63.4: handoff prompts go over the message channel with an acknowledgement, typed into the pty
  // only if the channel is unavailable, and are then VERIFIED in the transcript (retry with backoff,
  // every attempt logged to stuck-turn-watchdog.log). The pty is what silently lost them on 2026-10-03.
  function deliverHandoffPrompt(agentPath, text, flow, dopts) {
    let ptyTries = 0;
    const nm = agentName(agentPath);
    if (flow) flow.deliveryPending = (flow.deliveryPending || 0) + 1; // nudges wait for this (see advanceFlow)
    const settle = () => { if (flow) flow.deliveryPending = Math.max(0, (flow.deliveryPending || 1) - 1); };
    let p;
    try {
      p = window.HandoffDelivery.deliver(text, {
        channelSend: (t, o) => window.api.channelSend(agentPath, t, o),
        channelCancel: (id) => window.api.channelCancel(id),
        // first pty attempt respects the busy-queue; a retry must type directly or it would queue behind itself
        ptySend: (t) => { if (ptyTries++ === 0) queueOrSend(agentPath, t); else submitToAgent(agentPath, t); },
        // never type a duplicate while the first prompt still waits in the busy agent's queue
        ptyQueued: () => { const se = terminals.get(agentPath); return !!(se && se.sendQueue && se.sendQueue.some((q) => typeof q === "string" && q.indexOf(text) !== -1)); },
        // stop as soon as the flow is cleared, replaced, failed, reaped or past the saving phase
        aborted: () => !flow || flows.get(agentPath) !== flow || flow.phase !== "saving",
        transcriptHas: (m) => window.api.transcriptHas(agentPath, m),
        // v1.68.2 (B2): the typed prompt may sit unsent in the input box (the stuck-Enter check only arms for one unacked write at a time):
        // press Enter, once per look, when the screen shows exactly this prompt's text
        nudgeSubmit: async () => {
          const se = terminals.get(agentPath);
          if (!se || se.busy || se.transcriptWorking) return false;   // v1.69.1 (L4): never press Enter into a working agent
          const holds = await window.api.agentInputHoldsText(agentPath, text).catch(() => false);
          if (!holds) return false;
          window.autoHandoffLog(nm + ": handoff prompt sits unsent in the input box - pressing Enter");
          if (typeof writeQueued === "function") writeQueued(se, () => window.api.sendInput(agentPath, "\r")); else window.api.sendInput(agentPath, "\r");
          return true;
        },
        log: (line) => window.autoHandoffLog(nm + ": " + line),
      }, dopts);
    } catch (e) {
      settle();
      window.autoHandoffLog("handoff delivery error for " + nm + ": " + (e && e.message));
      return Promise.resolve(null);
    }
    return p.then((r) => {
      if (flow) { flow.delivery = r; flow.deliverySettledAt = Date.now(); }
      if (r && r.aborted) {
        // v1.63.8: the flow ended while the prompt still waits for a busy agent - drop it so it is not typed later
        const se = terminals.get(agentPath);
        if (se && window.HandoffDelivery.purgeQueue(se.sendQueue, text) && typeof renderQueue === "function") renderQueue(agentPath);
      }
      if (!r.delivered && !r.aborted) window.autoHandoffLog("handoff prompt for " + nm + " NOT confirmed in transcript after " + r.attempts + " attempts");
      return r;
    }).catch((e) => { if (flow) flow.deliverySettledAt = Date.now(); window.autoHandoffLog("handoff delivery error for " + nm + ": " + (e && e.message)); }).finally(settle);
  }

  // v1.63.4: the existing handoff_latest.md may predate this request entirely (the agent never saw it).
  function staleWarning(flow) {
    const s = window.HandoffDelivery.staleInfo({ exists: !!flow.existingMtimeMs, mtimeMs: flow.existingMtimeMs }, flow.startedAt);
    if (!s.stale) return "";
    const mins = Math.round(s.ageMs / 60000);
    return " WARNING: that file is STALE - it was last written " + (mins >= 60 ? Math.round(mins / 60) + " h" : mins + " min") +
      " before this handoff request, so it does not contain this session's lessons.";
  }

  async function startFlow(agentPath, confirmFirst) {
    try {
      if (!agentPath || flows.has(agentPath)) return;
      if (confirmFirst && !confirm("Ask this agent to save its lessons + a handoff file, then reset the session and resume from the handoff?")) return;
      const flow = { phase: "saving", startedAt: Date.now(), error: null, quietPolls: 0 };
      flows.set(agentPath, flow);
      parkQueue(agentPath, "handoff flow start");   // before the prompt goes out, so only the user's messages are parked
      flow.hid = window.HandoffDelivery.makeMarker();   // one hid per flow: the prompt is typed at most once under it
      flow.firstPrompt = handoffPrompt(agentPath);
      try { syncKeepGoing(); } catch (e) {}   // v1.69.1 (L3): tell main at once, not at the next 2 s tick, so no keep-going nudge crosses the handoff
      deliverHandoffPrompt(agentPath, flow.firstPrompt, flow, { marker: flow.hid });
      render();
      flow.timer = setInterval(() => advanceFlow(agentPath), FLOW_POLL_MS);
    } catch (e) {
      console.error("guards startFlow", e);
    }
  }

  async function advanceFlow(agentPath) {
    const flow = flows.get(agentPath);
    if (!flow || flow.phase !== "saving") return;
    try {
      parkQueue(agentPath, "queued during handoff");   // a message typed mid-flow must not block the idle test or reach the old conversation
      // Time spent stopped on a usage limit does not count: the agent cannot write anything then.
      const lim = await window.api.getLimitStatus(agentPath).catch(() => null);
      if (lim && lim.halt) flow.pausedMs = (flow.pausedMs || 0) + FLOW_POLL_MS;
      if (Date.now() - flow.startedAt - (flow.pausedMs || 0) > HANDOFF_TIMEOUT_MS) {
        const ex = await window.api.getHandoffInfo(agentPath);
        flow.canUseExisting = !!(ex && ex.exists);
        flow.existingMtimeMs = ex && ex.exists ? ex.mtimeMs : 0;
        flow.phase = "failed";
        window.autoHandoffLog("flow FAILED for " + agentName(agentPath));
        flow.error =
          "The agent did not finish the handoff within 12 minutes - nothing was reset." +
          (flow.canUseExisting ? " A handoff_latest.md already exists; if it is the one you want, use the button to reset with it." +
            staleWarning(flow) : "");
        clearInterval(flow.timer);
        render();
        return;
      }
      const session = terminals.get(agentPath);
      const info = await window.api.getHandoffInfo(agentPath);
      const fresh = info && info.exists && info.mtimeMs > flow.startedAt;
      // v1.52.1: session.busy alone is not "idle" - it drops to false after ~900ms of pty silence,
      // i.e. between any two tool calls. On 2026-09-24 the COO got the "has NOT been rewritten"
      // nudge twice while still mid-turn writing it (the file landed seconds later), and the same
      // test gates the reset below, which could cut a working agent off. The transcript must also
      // say the turn has ended.
      const act = await window.api.getSessionActivity(agentPath).catch(() => null);
      const idle = session && !session.busy && !(session.sendQueue && session.sendQueue.length) &&
        !(act && act.working);
      flow.quietPolls = fresh && idle ? flow.quietPolls + 1 : 0;
      // v1.24.3: the agent can finish its turn and even say "Handoff saved" WITHOUT writing the file
      // (Product Development, 2026-09-19: answered from an older handoff with zero tool calls, so the
      // flow sat until the 12-minute timeout). If it has been idle and the file is still not fresh,
      // tell it plainly, at most twice, instead of waiting out the clock.
      flow.idleStalePolls = idle && !fresh ? (flow.idleStalePolls || 0) + 1 : 0;
      let nudgeOk = false;
      if (flow.idleStalePolls >= 3 && (flow.nudges || 0) < 2) {
        if (window.HandoffLogic.mayNudge(flow)) nudgeOk = true;   // v1.68.2 (B2): first request confirmed
        else if (flow.firstPrompt && window.HandoffLogic.mayNudge(flow, Date.now(), { inputHolds: false, queued: false })) {
          // v1.69.1 (M2): first request never confirmed; bounded wait is over - one nudge, only if nothing of it can still land
          const holds = await window.api.agentInputHoldsText(agentPath, flow.firstPrompt).catch(() => true);
          const queued = !!(session && session.sendQueue && session.sendQueue.some((q) => typeof q === "string" && q.indexOf(flow.hid) !== -1));
          if (!holds && !queued) { nudgeOk = true; flow.unconfirmedNudged = true; window.autoHandoffLog(agentName(agentPath) + ": first handoff request never confirmed and not pending - sending one nudge"); }
        }
      }
      if (nudgeOk) {
        flow.nudges = (flow.nudges || 0) + 1;
        flow.idleStalePolls = 0;
        const fileP = agentPath.replace(/[\\/]+$/, "") + "\\handoff_latest.md";
        const last = info && info.exists ? new Date(info.mtimeMs).toLocaleTimeString() : "never";
        deliverHandoffPrompt(
          agentPath,
          window.HandoffLogic.nudgePrompt(fileP),
          flow
        );
        return;
      }
      // v1.67.1: do not wait for the agent's reply. A fresh file holding every required section whose mtime has
      // been stable for two polls is the handoff; the idle path above stays as the fallback.
      if (fresh && info.ready) {
        flow.readyPolls = flow.readyMtime === info.mtimeMs ? (flow.readyPolls || 0) + 1 : 1;
        flow.readyMtime = info.mtimeMs;
        flow.fileReady = true;
      } else { flow.readyPolls = 0; }
      // H1 (review): also require the agent to be done (not working): it may still be saving memory files or editing.
      const filePollsOk = flow.readyPolls >= 2 && !flow.deliveryPending && !(act && (act.working || act.pendingToolUse));
      if (!filePollsOk && flow.quietPolls < 2) { render(); return; } // not done yet (render keeps the countdown moving)
      await runReset(agentPath, flow);
    } catch (e) {
      flow.phase = "failed";
      window.autoHandoffLog("flow FAILED for " + agentName(agentPath));
      flow.error = "Handoff/reset stopped: " + e.message;
      clearInterval(flow.timer);
      render();
    }
  }

  // Archive the handoff, swap in a fresh session (performSessionReset no longer types /clear - see
  // its comment in renderer.js), then hand the resume message to tickResume(), which delivers it
  // and VERIFIES it reached the transcript (the old flow "succeeded" while the message was lost).
  async function runReset(agentPath, flow) {
    flow.phase = "resetting";
    clearInterval(flow.timer);
    render();
    const arch = await window.api.archiveHandoff(agentPath);
    if (!arch || !arch.ok) throw new Error((arch && arch.error) || "could not archive handoff");
    resetAt.set(agentPath, Date.now());
    // v1.62.0: the resume message rides along as the fresh session's FIRST prompt, so it is delivered
    // even if Iddo has moved to another agent (before, it waited for the agent's tab to be opened).
    // tickResume then only VERIFIES it; if it never lands it falls back to the old attach-and-send.
    let resumeText = resumePrompt(arch.path);
    // v1.69.0: main decides the text (continue-at-once when the handoff has open work and no BLOCKED) and sets the persisted
    // "mission in progress" marker; the old static text stays the fallback.
    try { const kg = await window.api.keepGoingResumePrompt(agentPath, arch.path); if (kg && kg.text && kg.text.startsWith(RESUME_MARKER)) resumeText = kg.text; } catch (e) { /* keep the static text */ }
    await performSessionReset(agentPath, { initialPrompt: resumeText });
    pendingResume.set(agentPath, { text: resumeText, path: arch.path, readySince: null, sentAt: Date.now(), viaDispatch: true, tries: 1 });
    flow.phase = "resuming";
    render();
  }

  // Runs every 2s. For each pending resume: wait until the fresh session is attached (it only
  // attaches once the agent is opened), give it a few seconds to settle, send, then confirm the
  // marker landed in the transcript. Resend once if not; after that tell the user what to do.
  // v1.69.0 (M4): tell main which agents have a handoff running so keep-going never nudges them (only sent when the list changes)
  let kgActiveKey = null; // null: the first tick after a (re)load always sends the list, so main never keeps a stale flag
  function syncKeepGoing() {
    try {
      const act = [];
      for (const [ap, f] of flows.entries()) if (f && (f.phase === "saving" || f.phase === "resetting" || f.phase === "resuming")) act.push(ap);
      for (const ap of pendingResume.keys()) if (!act.includes(ap)) act.push(ap);
      const key = act.slice().sort().join("|");
      if (key !== kgActiveKey) { kgActiveKey = key; window.api.keepGoingHandoffActive(act); }
    } catch (e) { /* never break the handoff */ }
  }
  async function tickResume() {
    restoreParkedQueues();
    syncKeepGoing();
    for (const [ap, r] of Array.from(pendingResume.entries())) {
      try {
        const flow = flows.get(ap);
        const s = terminals.get(ap);
        if (!r.viaDispatch && (!s || !s.started)) {
          r.readySince = null;
          continue;
        }
        if (!r.readySince) r.readySince = Date.now();
        if (!r.sentAt) {
          if (Date.now() - r.readySince < RESUME_SETTLE_MS || s.busy) continue;
          r.sentAt = Date.now();
          r.tries++;
          submitToAgent(ap, r.text);
          continue;
        }
        if (await window.api.transcriptHas(ap, RESUME_MARKER)) {
          pendingResume.delete(ap);
          if (flow) {
            flow.phase = "done";
            recordHandoffDuration((Date.now() - flow.startedAt) / 1000);
            window.autoHandoffLog("flow finished OK for " + agentName(ap));
            render();
            setTimeout(() => {
              flows.delete(ap);
              render();
            }, 8000);
          }
        } else if (Date.now() - r.sentAt > RESUME_VERIFY_MS) {
          // Busy means it got the message and is acting on it - the marker
          // just has not been flushed to the transcript yet. Keep waiting, up
          // to a hard ceiling so a genuinely stuck session still reports.
          let working = false;
          try {
            const act = await window.api.getSessionActivity(ap);
            working = !!(act && act.working);
          } catch (e) {}
          if (working && Date.now() - r.sentAt < RESUME_MAX_WAIT_MS) continue;
          if (r.tries < 3) {
            r.sentAt = null; // not received - send it again (by typing, once the tab is attached)
            r.readySince = Date.now();
            r.viaDispatch = false;
          } else {
            pendingResume.delete(ap);
            if (flow) {
              flow.phase = "failed";
              window.autoHandoffLog("flow FAILED for " + agentName(ap));
              flow.error = "The fresh session did not confirm the resume message after " + r.tries +
              " attempts. It may still have arrived - check the conversation before resending. If not: Read " +
              r.path + " and continue from there.";
              render();
            }
          }
        }
      } catch (e) {
        console.error("guards tickResume", e);
      }
    }
  }
  setInterval(tickResume, 2000);

  // ------------------------------------------------------------ fleet handoff (v1.25.0)
  // "Handoff all": runs the same per-agent flow (startFlow) over every agent above the context
  // threshold, ONE AT A TIME, biggest first, so nobody has to click through 15 agents. It opens each
  // agent (selectAgent) because the flow needs the agent's terminal session; the view follows the run
  // and returns to the agent you were on. Busy agents are waited for (2 min) then skipped; the run
  // stops early if the 5-hour window is >= 90% or the weekly one >= 97% (each handoff costs usage).
  const allBanner = el("guard-all-banner");
  chatView.insertBefore(allBanner, limitBanner);
  let allRun = null; // { queue:[{agent,tokens}], results:[{name,status}], current, cancelled, finished, originalPath }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const allBtn = document.createElement("button");
  allBtn.id = "handoff-all-btn";
  allBtn.textContent = "Handoff all";
  allBtn.title = "Runs Handoff & reset (save lessons, then wipe and restart from that handoff) on every agent whose conversation is over " + Math.round(CONTEXT_WARN_TOKENS / 1000) + "K tokens - one agent at a time, most expensive first.";
  if (resetBtn && resetBtn.parentNode) resetBtn.parentNode.insertBefore(allBtn, resetBtn);
  allBtn.addEventListener("click", () => startAll());

  function renderAll() {
    if (!allRun) {
      allBanner.className = "guard-banner hidden";
      return;
    }
    const r = allRun;
    const done = r.results.length;
    if (!r.finished) {
      show(
        allBanner,
        "guard-blue",
        "Handoff all: " + done + " of " + r.queue.length + " done" + (r.current ? " - working on " + r.current : "") + ". The view switches between agents while this runs.",
        [{ label: "Cancel", onClick: () => { r.cancelled = true; renderAll(); } }]
      );
      return;
    }
    const failed = r.results.filter((x) => /^(FAILED|timed out|stopped)/.test(x.status)).length;
    const lines = r.results.map((x) => x.name + ": " + x.status).join(" | ");
    const notRun = r.queue.length - done;
    show(
      allBanner,
      failed || notRun ? "guard-amber" : "guard-green",
      "Handoff all finished. " + lines + (notRun > 0 ? " | " + notRun + " not started" + (r.cancelled ? " (cancelled)" : "") : ""),
      [{ label: "Dismiss", onClick: () => { allRun = null; renderAll(); } }]
    );
  }

  async function startAll() {
    if (allRun && !allRun.finished) return;
    const cands = [];
    for (const a of agents) {
      try {
        const u = await window.api.getContextUsage(a.path);
        let t = u && typeof u.contextTokens === "number" ? u.contextTokens : 0;
        if (t && window.guardUsageIsStale(a.path, u)) t = 0;
        if (t >= CONTEXT_WARN_TOKENS) cands.push({ agent: a, tokens: t });
      } catch (e) {}
    }
    cands.sort((x, y) => y.tokens - x.tokens);
    if (!cands.length) {
      alert("No agent is above " + Math.round(CONTEXT_WARN_TOKENS / 1000) + "K tokens of context - nothing to hand off.");
      return;
    }
    const list = cands.map((c) => "  " + c.agent.displayName + " - " + Math.round(c.tokens / 1000) + "K tokens").join("\n");
    if (
      !confirm(
        "Hand off " + cands.length + " agent(s), one at a time, biggest first?\n\n" + list +
          "\n\nEach agent saves its lessons + a handoff file, then gets a fresh session. The view will switch between agents while this runs (it returns to your current agent at the end). Busy agents are skipped."
      )
    )
      return;
    allRun = { queue: cands, results: [], current: null, cancelled: false, finished: false, originalPath: activeAgentPath };
    renderAll();
    runAll();
  }

  async function runAll() {
    const run = allRun;
    try {
      for (const c of run.queue) {
        if (run.cancelled) break;
        const name = c.agent.displayName;
        run.current = name;
        renderAll();
        const lim = await window.api.getLimitStatus(c.agent.path).catch(() => null);
        const five = lim && lim.fiveHour && lim.fiveHour.usedPct;
        const week = lim && lim.sevenDay && lim.sevenDay.usedPct;
        if (five >= 90 || week >= 97) {
          run.results.push({ name, status: "stopped - usage window at " + Math.round(Math.max(five || 0, week || 0)) + "% (each handoff costs usage)" });
          break;
        }
        let outcome;
        try {
          outcome = await handoffOne(c.agent, run);
        } catch (e) {
          outcome = { status: "FAILED: " + e.message };
        }
        run.results.push({ name, status: outcome.status });
      }
    } finally {
      run.finished = true;
      run.current = null;
      try {
        if (run.originalPath && run.originalPath !== activeAgentPath) {
          const back = agents.find((a) => a.path === run.originalPath);
          if (back) selectAgent(back);
        }
      } catch (e) {}
      renderAll();
    }
  }

  async function handoffOne(agent, run) {
    const ap = agent.path;
    if (flows.has(ap)) return { status: "skipped (a handoff is already running)" };
    selectAgent(agent); // opens/attaches it if it was never opened this run
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const s0 = terminals.get(ap);
      if (s0 && s0.started && Date.now() - t0 > 6000) break;
      if (run.cancelled) return { status: "cancelled" };
      await sleep(1000);
    }
    const s = terminals.get(ap);
    if (!s || !s.started) return { status: "skipped (could not attach)" };
    const t1 = Date.now();
    while ((s.busy || s.transcriptWorking) && Date.now() - t1 < 120000) {
      if (run.cancelled) return { status: "cancelled" };
      await sleep(2000);
    }
    if (s.busy || s.transcriptWorking) return { status: "skipped (busy)" };
    await startFlow(ap, false);
    const t2 = Date.now();
    while (Date.now() - t2 < 25 * 60 * 1000) {
      if (run.cancelled) return { status: "cancelled during its handoff (that one keeps running)" };
      const f = flows.get(ap);
      if (!f || f.phase === "done") return { status: "done" };
      if (f.phase === "failed") {
        const err = f.error || "failed";
        clearInterval(f.timer);
        flows.delete(ap);
        pendingResume.delete(ap);
        render();
        return { status: "FAILED: " + err };
      }
      await sleep(2000);
    }
    return { status: "timed out waiting for it" };
  }

  function fmtReset(sec) {
    if (!sec) return "";
    const d = new Date(sec > 1e12 ? sec : sec * 1000);
    const mins = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
    const left = mins >= 60 ? Math.floor(mins / 60) + "h " + (mins % 60) + "m" : mins + "m";
    return " - resets " + d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + " (in " + left + ")";
  }

  function show(box, cls, html, buttons) {
    box.className = "guard-banner " + cls;
    box.textContent = "";
    const span = document.createElement("span");
    span.className = "guard-text";
    span.textContent = html;
    box.appendChild(span);
    for (const b of buttons || []) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.addEventListener("click", b.onClick);
      box.appendChild(btn);
    }
  }

  // 2026-09-20: the auth-broken banner used to just print `claude auth login`
  // as text, which fails from a plain PowerShell window on this machine
  // (claude.cmd is a symlink Windows can't always resolve - memory
  // claude-cmd-symlink-flakiness) and forced Iddo to hunt down the real
  // claude.exe path by hand. This button calls guard-trigger-login (main.js),
  // which reuses the app's own resolveClaudeExecutable() and opens a normal
  // console window running it - one click instead of a path hunt.
  function loginButton() {
    return {
      label: "Log in now",
      onClick: async (e) => {
        const btn = e && e.target;
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Opening…";
        }
        try {
          const r = await window.api.triggerClaudeLogin();
          if (btn) btn.textContent = r && r.ok ? "Opened - finish in the browser" : "Failed - see Raw Terminal";
        } catch (err) {
          if (btn) btn.textContent = "Failed to open";
        }
      },
    };
  }

  // Delegates to the real Restart Session button rather than re-implementing
  // its logic (conversation lookup, the busy-turn confirm dialog, the
  // switch-conversation IPC call, button state during the restart).
  function restartButton() {
    return {
      label: "Restart Session",
      onClick: () => {
        const btn = document.getElementById("restart-session-btn");
        if (btn) btn.click();
      },
    };
  }

  let lastLimit = null;
  function render() {
    try {
      const ap = activeAgentPath;
      // --- limit banner
      if (!ap || !lastLimit) {
        limitBanner.className = "guard-banner hidden";
      } else if (lastLimit.authBroken) {
        // Global - shown on any agent's tab, even one that hasn't tried and failed yet itself.
        show(limitBanner, "guard-red", "NOT RESPONDING - Claude login expired for ALL agents (not a usage limit).", [loginButton(), restartButton()]);
      } else if (lastLimit.halt && lastLimit.halt.error === "authentication_failed") {
        // Not a usage limit: the CLI's login expired/was signed out, so every prompt fails instantly.
        show(limitBanner, "guard-red", "NOT RESPONDING - Claude login expired (not a usage limit).", [loginButton(), restartButton()]);
      } else if (lastLimit.halt && lastLimit.halt.resetsAt && Date.now() > lastLimit.halt.resetsAt) {
        // The window this halt was waiting on has already reset (2026-09-20:
        // Trade Show agent showed a red STOPPED banner hours after its 5h
        // window rolled over, because the halt message stays the last
        // transcript entry until the agent is next prompted). Not stopped any
        // more - just idle; say so instead of alarming.
        show(limitBanner, "guard-amber", "This agent hit a usage limit earlier, but that window has since reset - it is idle, not blocked. Send any message (or \"continue\") to resume.", []);
      } else if (lastLimit.halt && lastLimit.halt.kind === "server_error") {
        // Anthropic's own API failed; this is not a quota. Calling it a usage
        // limit sent Iddo looking for a reset time that did not exist
        // (2026-09-22, a 500 on the Product Development Agent while its usage
        // sat at 2%). The actual fix is to send the message again, so say so.
        show(limitBanner, "guard-amber",
          "STOPPED - Claude's API returned an error (" + (lastLimit.halt.apiErrorStatus || "5xx") +
          "), not a usage limit. This is usually temporary: send your message again.", [restartButton()]);
      } else if (lastLimit.halt && lastLimit.halt.kind !== "rate_limit") {
        // Any other API failure: show what it actually said rather than
        // inventing a cause. A wrong diagnosis costs more than a vague one.
        const detail = (lastLimit.halt.text || lastLimit.halt.error || "").trim();
        show(limitBanner, "guard-amber",
          "STOPPED - the last turn failed with an API error, not a usage limit." +
          (detail ? " " + detail.slice(0, 160) : "") + " Send your message again.", [restartButton()]);
      } else if (lastLimit.halt) {
        const t =lastLimit.halt.resetsAt ? " - resets around " + new Date(lastLimit.halt.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ", then this agent auto-continues" : "";
        show(limitBanner, "guard-red", "STOPPED - Claude " + (lastLimit.halt.rateLimitType || "usage") + " limit reached" + t, []);
      } else {
        const parts = [];
        let worst = 0;
        for (const [k, label] of [["fiveHour", "5-hour"], ["sevenDay", "weekly"]]) {
          const w = lastLimit[k];
          if (w && typeof w.usedPct === "number" && w.usedPct >= 80) {
            parts.push(label + " usage " + Math.round(w.usedPct) + "%" + fmtReset(w.resetsAt));
            worst = Math.max(worst, w.usedPct);
          }
        }
        if (parts.length) show(limitBanner, worst >= 95 ? "guard-red" : "guard-amber", "Approaching the limit: " + parts.join("  |  "), []);
        else limitBanner.className = "guard-banner hidden";
      }

      // --- held messages (v1.67.1)
      const held = ap && parkedQueues.get(ap);
      if (held && held.items.length) {
        const short = (t) => { const s = (window.longMessageDisplayText && window.longMessageDisplayText(t)) || String(t); return s.length > 60 ? s.slice(0, 57) + "..." : s; };
        show(heldBanner, "guard-blue", "Held until the handoff finishes (" + held.items.length + ") - sent in order to the fresh session: " + held.items.map(short).join(" | "), []);
      } else heldBanner.className = "guard-banner hidden";

      // --- context / handoff banner
      const flow = ap && flows.get(ap);
      if (flow) {
        const hl = window.HandoffLogic;
        const stageNow = flow.phase === "saving" ? (flow.fileReady ? "ready" : flow.deliveryPending ? "delivering" : "writing") : flow.phase;
        const prog = () => hl.progressText(stageNow, Math.round((Date.now() - flow.startedAt) / 1000), hl.estimateSecs(handoffDurations()), (parkedQueues.get(ap) || { items: [] }).items.length);
        if (flow.phase === "saving" || flow.phase === "resetting" || flow.phase === "resuming") show(ctxBanner, "guard-blue", prog(), []);
        else if (flow.phase === "done") show(ctxBanner, "guard-green", "Reset done and confirmed: the new session received the handoff and is reading it; the red marker above lists the lessons carried over.", []);
        else {
          const btns = [{ label: "Dismiss", onClick: () => { flows.delete(ap); pendingResume.delete(ap); render(); } }];
          // The handoff file may exist already (e.g. it was written before a retry click, or after a timeout):
          // let the user reset using it instead of making the agent write it again.
          if (flow.canUseExisting) {
            btns.unshift({
              label: staleWarning(flow) ? "Reset using the existing handoff (STALE)" : "Reset using the existing handoff",
              onClick: async () => {
                try {
                  if (staleWarning(flow) && !confirm("handoff_latest.md is older than this handoff request - it will NOT contain this session's lessons. Reset with it anyway?")) return;
                  flow.canUseExisting = false;
                  await runReset(ap, flow);
                } catch (e) {
                  flow.phase = "failed";
                  window.autoHandoffLog("flow FAILED for " + agentName(ap));
                  flow.error = "Handoff/reset stopped: " + e.message;
                  render();
                }
              },
            });
          }
          show(ctxBanner, "guard-red", flow.error || "Handoff failed.", btns);
        }
      } else if (ap && ctxTokens !== null && ctxTokens >= CONTEXT_WARN_TOKENS && !(dismissedAt.has(ap) && ctxTokens < dismissedAt.get(ap) + REDISMISS_GROWTH_TOKENS)) {
        show(
          ctxBanner,
          "guard-amber",
          "This conversation is " + Math.round(ctxTokens / 1000) + "K tokens - every message re-reads all of it, so it costs far more than a fresh session. A handoff reset (lessons saved to memory first) typically saves ~30-40% of this agent's usage.",
          [
            { label: "Save handoff & reset", onClick: () => startFlow(ap, false) },
            { label: "Later", onClick: () => { dismissedAt.set(ap, ctxTokens); render(); } },
          ]
        );
      } else {
        ctxBanner.className = "guard-banner hidden";
      }
    } catch (e) {
      console.error("guards render", e);
    }
  }

  async function tick() {
    try {
      const ap = activeAgentPath;
      if (!ap) {
        lastLimit = null;
        ctxTokens = null;
        render();
        return;
      }
      const [usage, lim] = await Promise.all([window.api.getContextUsage(ap), window.api.getLimitStatus(ap)]);
      if (ap !== activeAgentPath) return;
      ctxTokens = usage && typeof usage.contextTokens === "number" ? usage.contextTokens : null;
      // After a reset the newest assistant entry on disk is still the OLD session's until the
      // new session replies - ignore any usage stamped before the reset (stale 204K banner bug).
      if (ctxTokens !== null && window.guardUsageIsStale(ap, usage)) ctxTokens = null;
      lastLimit = lim;
      render();
    } catch (e) {
      console.error("guards tick", e);
    }
  }
  // v1.58.0: read by app-update-overlay.js - Update & restart waits while a
  // handoff is mid-flight (a restart would cut it between reset and resume).
  window.guardsAgentInFlow = (ap) => flows.has(ap) || pendingResume.has(ap) || !!nearHandoff.get(ap) || !!(allRun && !allRun.finished); // v1.65.0
  window.guardsFlowActive = (ap) => window.HandoffLogic.flowHoldsMessages(flows.get(ap), pendingResume.has(ap)); // v1.68.2 (B1)
  window.guardsBusyReason = () => {
    if (allRun && !allRun.finished) return "\"Handoff all\" is running";
    if (flows.size) return "a handoff is in progress";
    if (pendingResume.size) return "a handed-off agent is waiting for its resume message";
    return null;
  };
  setInterval(tick, TICK_MS);
  setInterval(() => { checkAutoHandoff().catch(() => {}); }, AUTO_HANDOFF_CHECK_MS);
  setTimeout(tick, 1500);
  // Re-check right away when the user switches agents (activeAgentPath changes).
  let lastAgent = null;
  setInterval(() => {
    if (activeAgentPath !== lastAgent) {
      lastAgent = activeAgentPath;
      ctxTokens = null;
      lastLimit = null;
      render();
      tick();
    }
  }, 500);
})();

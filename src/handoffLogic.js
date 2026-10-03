// v1.67.1: small pure helpers for the handoff flow (renderer: window.HandoffLogic, main/tests: require).
// Everything here is deterministic and unit-tested (tests/handoffLogic.test.js).
(function (root) {
  const REQUIRED_SECTIONS = ["## LESSONS", "## OPEN NOW", "## STATE", "## KEY FACTS"];

  // ONE line, nothing else. The hid marker is added by HandoffDelivery.deliver (body = marker + " " + text).
  function handoffPrompt(file, opts) {
    return "First save durable lessons to memory, then write " + file + " LAST (sections LESSONS, OPEN NOW, STATE, KEY FACTS)" +
      (opts && opts.interrupted ? "; in STATE say what was in flight" : "") + ", then reply only: Handoff saved";
  }
  function nudgePrompt(file) {
    return "Handoff file " + file + " is still not written: write it with a tool now, then reply only: Handoff saved";
  }

  // The handoff file is usable as soon as it holds every required section heading with some content.
  function fileReady(text) {
    const t = String(text || "");
    if (t.length < 80) return false;
    return REQUIRED_SECTIONS.every((h) => new RegExp("^" + h.replace(/[#]/g, "\\#") + "\\b", "mi").test(t));
  }

  // Estimated total seconds of a handoff from the last few real durations (median), default 90 s.
  function estimateSecs(history) {
    const h = (Array.isArray(history) ? history : []).filter((x) => typeof x === "number" && x > 5 && x < 3600).slice(-5);
    if (!h.length) return 90;
    const s = h.slice().sort((a, b) => a - b);
    return Math.round(s[Math.floor(s.length / 2)]);
  }

  // Stage text for the banner: stage is one of delivering | writing | ready | resetting | resuming.
  function progressText(stage, elapsedSecs, estSecs, heldCount) {
    const left = Math.max(0, estSecs - elapsedSecs);
    const eta = left > 0 ? "~" + left + " s left" : "taking longer than usual (" + elapsedSecs + " s so far)";
    const stages = {
      delivering: "asking the agent to write the handoff",
      writing: "prompt delivered, the agent is writing handoff_latest.md",
      ready: "handoff file written, finishing up",
      resetting: "starting a fresh session",
      resuming: "fresh session started, sending it the handoff",
    };
    const held = heldCount ? " Your " + heldCount + " message" + (heldCount > 1 ? "s are" : " is") + " kept and sent afterwards." : " Messages you type are kept and sent afterwards.";
    return "Handoff in progress (" + eta + "): " + (stages[stage] || stage) + "." + held;
  }

  // The "held until the handoff finishes" user messages (guards.js parkedQueues: agentPath -> { items, at }) are
  // written to disk after every change so an app restart in the middle of a handoff does not lose them.
  function serializeHeld(map) {
    const out = {};
    for (const [ap, v] of map.entries()) if (v && Array.isArray(v.items) && v.items.length) out[ap] = { items: v.items.filter((x) => typeof x === "string"), at: v.at || 0 };
    return JSON.stringify(out);
  }
  // Returns Map(agentPath -> { items, at }). `at` is forced to 0 so the restore tick treats loaded items as old
  // (a restart ended the flow that parked them).
  function parseHeld(json) {
    const m = new Map();
    try {
      const o = JSON.parse(json);
      for (const ap of Object.keys(o || {})) {
        const v = o[ap];
        if (v && Array.isArray(v.items)) {
          const items = v.items.filter((x) => typeof x === "string" && x);
          if (items.length) m.set(ap, { items, at: 0 });
        }
      }
    } catch (e) { /* corrupt file: start empty */ }
    return m;
  }

  // v1.68.2 (B1): while a handoff flow is running (saving / resetting / resuming) or a fresh session still waits for
  // its resume message, a message the user types must be HELD even if the agent is idle at that moment - an idle
  // agent used to take the "send now" branch and the text went into the dying pty or the old conversation.
  function flowHoldsMessages(flow, hasPendingResume) {
    if (hasPendingResume) return true;
    return !!flow && (flow.phase === "saving" || flow.phase === "resetting" || flow.phase === "resuming");
  }
  // v1.68.2 (B2): a second handoff request (the "write it now" nudge) may only be typed once the FIRST request is
  // confirmed in the transcript. While the first is unconfirmed (it may sit unsent in the input box) a second
  // prompt would reach the fresh session next to it as a duplicate request.
  // v1.69.1 (M2): if the first request was never confirmed (gave up after its attempts, or errored), ONE nudge is
  // allowed after a bounded wait (waitMs after the delivery settled) and only when nothing of the first request can
  // still be pending: its text is not in the CLI input box and not in the app queue. Otherwise the flow would just
  // idle until the 12-minute timeout.
  function mayNudge(flow, nowMs, state) {
    if (!flow || flow.deliveryPending) return false;
    if (flow.delivery && flow.delivery.delivered === true) return true;
    if (flow.delivery && flow.delivery.aborted) return false;
    const st = state || {};
    const waitMs = st.waitMs == null ? 60000 : st.waitMs;
    if (!flow.deliverySettledAt || (nowMs || Date.now()) - flow.deliverySettledAt < waitMs) return false;
    if (st.inputHolds !== false || st.queued) return false;     // unknown or present: may still land
    return !flow.unconfirmedNudged;
  }
  // v1.69.1 (H1): how restored (held) messages are handed to a session. A working agent gets them mid-turn, exactly
  // like a normal send; an idle one drains through its queue; a dialog on screen or mid-turn delivery switched off
  // keeps the old queue behaviour.
  function restoreRoute(s) {
    if (!s || !s.working) return "queue";
    return s.midTurnOk && !s.dialogOpen ? "midturn" : "queue";
  }

  const api = { REQUIRED_SECTIONS, flowHoldsMessages, mayNudge, restoreRoute, handoffPrompt, nudgePrompt, fileReady, estimateSecs, progressText, serializeHeld, parseHeld };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.HandoffLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

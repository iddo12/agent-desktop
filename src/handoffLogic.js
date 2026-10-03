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

  const api = { REQUIRED_SECTIONS, handoffPrompt, nudgePrompt, fileReady, estimateSecs, progressText, serializeHeld, parseHeld };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.HandoffLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

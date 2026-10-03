// node tests/keepGoingGlue.test.js - safety rails of the keep-going nudger (src/keepGoingGlue.js)
const assert = require("assert");
const K = require("../src/keepGoing");
const G = require("../src/keepGoingGlue");

let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }

const iso = (ms) => new Date(ms).toISOString();
const asst = (ts, text, tool) => JSON.stringify({ type: "assistant", timestamp: iso(ts), message: { content: [].concat(text ? [{ type: "text", text }] : [], tool ? [{ type: "tool_use", name: "Bash" }] : []) } });
const usr = (ts, text) => JSON.stringify({ type: "user", timestamp: iso(ts), message: { content: text } });
const res = (ts) => JSON.stringify({ type: "user", timestamp: iso(ts), message: { content: [{ type: "tool_result", content: "ok" }] } });

// fake world: one agent "A" with a settable transcript
function world(extra) {
  const w = { t: Date.parse("2026-10-03T12:00:00Z"), lines: [], sigN: 0, sent: [], logs: [], emitted: [], saved: null, working: false, halt: null, paused: false, throttle: null, file: "", ...extra };
  w.set = (lines) => { w.lines = lines; w.sigN++; };
  w.g = G.create({
    now: () => w.t, log: (l) => w.logs.push(l), emit: (p, s) => w.emitted.push(s),
    agents: () => ["A"],
    readTail: () => ({ text: w.lines.join("\n"), partialFirst: false, sig: "s" + w.sigN }),
    isWorking: () => w.working, getHalt: () => w.halt, isPaused: () => w.paused,
    deliver: async (p, text) => { w.sent.push({ p, text }); return { delivered: true, via: "channel" }; },
    readThrottle: () => w.throttle, readFile: () => w.file,
    storage: { load: () => w.saved, save: (o) => { w.saved = JSON.parse(JSON.stringify(o)); } },
  });
  return w;
}
const END = "Fixed it.\n\nNext: running the full test suite.";
const tick = async (w, advance) => { w.t += advance == null ? 0 : advance; w.g.tick(); await new Promise((r) => setImmediate(r)); };

(async () => {
  // basic: nudge once, then not for the same text
  {
    const w = world();
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    await tick(w);
    assert.strictEqual(w.sent.length, 1);
    assert.ok(w.sent[0].text.startsWith("[[KEEPGOING]]"));
    w.sigN++; await tick(w, 200000); // same text, new signature (e.g. a bookkeeping line)
    t("same message text is never nudged twice", () => assert.strictEqual(w.sent.length, 1));
    t("nudge is logged with agent + reason", () => assert.ok(w.logs.some((l) => /NUDGE #1 to A - announces a next action/.test(l))));
  }
  // 3 consecutive nudges max, then stopped + visible state; 90 s gap
  {
    const w = world();
    const msgs = ["Next: step one.", "Next: step two.", "Next: step three.", "Next: step four."];
    let ts = w.t - 600000;
    w.set([usr(ts, "go"), asst(ts + 1000, msgs[0])]);
    w.t = ts + 60000; await tick(w);
    for (let i = 1; i <= 3; i++) {
      // agent answers the nudge with a new announcement, no tool calls
      const lines = [usr(ts, "go"), asst(ts + 1000, msgs[0])];
      for (let j = 1; j < i; j++) lines.push(usr(w.t, "[hid:x] " + K.NUDGE_TEXT), asst(w.t + 1000, msgs[j]));
      lines.push(usr(w.t, "[hid:x] " + K.NUDGE_TEXT), asst(w.t + 1000, msgs[i]));
      w.set(lines);
      w.t += 30000; await tick(w);                // < 90 s since the last nudge: deferred
      t("90 s minimum gap #" + i, () => assert.strictEqual(w.sent.length, i));
      w.t += 70000; await tick(w);                // now past the gap
    }
    t("max 3 consecutive nudges", () => assert.strictEqual(w.sent.length, 3));
    t("then marked stopped, once", () => {
      assert.ok(w.emitted.some((s) => s.state === "stopped"));
      assert.strictEqual(w.g.getSettings().stopped.length, 1);
      assert.strictEqual(w.logs.filter((l) => /STOPPED - nobody blocked it/.test(l)).length, 1);
    });
    // a new human message resets
    w.set(w.lines.concat([usr(w.t, "please carry on"), asst(w.t + 1000, "Next: step five.")]));
    w.t += 200000; await tick(w);
    t("a person's message resets counters and clears stopped", () => { assert.strictEqual(w.g.getSettings().stopped.length, 0); assert.strictEqual(w.sent.length, 4); });
  }
  // progress (tool calls after a nudge) resets the streak
  {
    const w = world();
    let b = w.t - 900000;
    w.set([usr(b, "go"), asst(b + 1000, "Next: a.")]);
    w.t = b + 60000; await tick(w);
    w.set([usr(b, "go"), asst(b + 1000, "Next: a."), usr(w.t, "[hid:x] " + K.NUDGE_TEXT), asst(w.t + 1000, "", true), res(w.t + 2000), asst(w.t + 3000, "Next: b.")]);
    w.t += 120000; await tick(w);
    t("progress resets the streak (counter back to 1 after second nudge)", () => { assert.strictEqual(w.sent.length, 2); assert.strictEqual(w.g._state().counters.A.consecutive, 1); });
  }
  // kill switches
  {
    const w = world();
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    w.g.setEnabled("A", false); await tick(w);
    t("per-agent switch off: no nudge, persisted", () => { assert.strictEqual(w.sent.length, 0); assert.deepStrictEqual(w.saved.agents.A, { enabled: false }); });
    w.g.setEnabled("A", true); w.g.setEnabled(null, false); await tick(w);
    t("global switch off: no nudge", () => { assert.strictEqual(w.sent.length, 0); assert.strictEqual(w.saved.globalEnabled, false); });
    w.g.setEnabled(null, true); await tick(w);
    t("switched back on: nudges", () => assert.strictEqual(w.sent.length, 1));
  }
  // throttle HOLD / paused / working / halt
  for (const [name, extra] of [["throttle HOLD", { throttle: "HOLD" }], ["paused", { paused: true }], ["working", { working: true }], ["halt", { halt: { kind: "rate_limit" } }]]) {
    const w = world(extra);
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    await tick(w);
    t("no nudge when " + name, () => assert.strictEqual(w.sent.length, 0));
  }
  { const w = world({ throttle: "SLOW" }); w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]); await tick(w); t("SLOW still nudges", () => assert.strictEqual(w.sent.length, 1)); }
  // settling / human typing defers and re-checks without a new signature
  {
    const w = world();
    w.set([usr(w.t - 400000, "go"), asst(w.t - 5000, END)]);
    await tick(w);
    t("settling: not yet", () => assert.strictEqual(w.sent.length, 0));
    await tick(w, 30000);
    t("settling: nudged once the quiet time passed, same signature", () => assert.strictEqual(w.sent.length, 1));
  }
  // done / blocked clear the mission
  {
    const w = world({ file: "## LESSONS\n- a\n## OPEN NOW\n- finish X\n## STATE\nExact next step: do Y\n## KEY FACTS\nz" });
    const r = w.g.resumeText("A", "D:\\a\\h.md");
    t("handoff with open work sets the mission marker and the continue-now text", () => { assert.ok(r.mission); assert.ok(/IMMEDIATELY/.test(r.text)); assert.strictEqual(w.saved.mission.A.active, true); });
    const RES = "[hid:q] " + r.text;
    w.set([usr(w.t - 400000, RES), asst(w.t - 300000, "Read the handoff. Ready.")]);
    await tick(w);
    t("fresh session idle after handoff gets nudged, counters not reset by the handoff", () => { assert.strictEqual(w.sent.length, 1); assert.strictEqual(w.g._state().counters.A.consecutive, 1); });
    w.set([usr(w.t - 400000, RES), asst(w.t - 300000, "Read the handoff. Ready."), usr(w.t - 200000, "[hid:z] " + K.NUDGE_TEXT), asst(w.t - 100000, "BLOCKED: needs Iddo's key")]);
    await tick(w);
    t("BLOCKED after nudge clears the mission, no further nudge", () => { assert.strictEqual(w.sent.length, 1); assert.strictEqual(w.saved.mission.A.active, false); });
  }
  {
    const w = world({ file: "## LESSONS\n- a\n## OPEN NOW\nBLOCKED: waiting for Iddo\n## STATE\ns\n## KEY FACTS\nz" });
    const r = w.g.resumeText("A", "P");
    t("handoff declaring BLOCKED: old two-line resume text, no mission", () => { assert.strictEqual(r.mission, false); assert.ok(/two short lines/.test(r.text)); });
  }
  // persistence round trip
  {
    const w = world();
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    await tick(w);
    const saved = w.saved;
    const w2 = world({ saved });
    w2.set(w.lines); w2.t = w.t + 200000; w2.sigN = 7;
    w2.g.tick(); await new Promise((r) => setImmediate(r));
    t("restart keeps the nudged-text memory (no repeat after an app restart)", () => assert.strictEqual(w2.sent.length, 0));
  }

  console.log((n - fails) + "/" + n + " keepGoingGlue tests passed");
  process.exit(fails ? 1 : 0);
})();

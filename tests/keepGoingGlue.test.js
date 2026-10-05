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
    readThrottle: () => w.throttle, limits: { warmupMs: 0 }, readFile: () => w.file,
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

  // H2: HOLD, then GO, same transcript: the agent is nudged after HOLD lifts
  {
    const w = world({ throttle: "HOLD" });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    await tick(w); await tick(w, 1000);
    assert.strictEqual(w.sent.length, 0);
    t("HOLD logged once, not per tick", () => assert.strictEqual(w.logs.filter((l) => /throttle is HOLD/.test(l)).length, 1));
    w.throttle = "GO";
    await tick(w, 70000); await tick(w, 1000);
    t("H2: after HOLD lifts the unchanged transcript is judged again and nudged", () => assert.strictEqual(w.sent.length, 1));
  }
  // M1: a nudge that never lands is rolled back, retried later, then surfaced as stopped
  {
    const w = world();
    w.deliveries = 0;
    w.g = G.create({ now: () => w.t, log: (l) => w.logs.push(l), emit: (p, s) => w.emitted.push(s), agents: () => ["A"], limits: { warmupMs: 0 },
      readTail: () => ({ text: w.lines.join("\n"), partialFirst: false, sig: "s" + w.sigN }), isWorking: () => false, readThrottle: () => null,
      deliver: async () => { w.deliveries++; return { delivered: false, attempts: 3 }; }, storage: { load: () => null, save: (o) => { w.saved = JSON.parse(JSON.stringify(o)); } } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    await tick(w);
    t("M1: failed delivery does not count (consecutive rolled back)", () => { assert.strictEqual(w.deliveries, 1); assert.strictEqual(w.g._state().counters.A.consecutive, 0); });
    await tick(w, 60000);
    t("M1: not retried before retryAfter", () => assert.strictEqual(w.deliveries, 1));
    await tick(w, 130000); await tick(w, 200000); await tick(w, 200000);
    t("M1: retried, then marked stopped with the delivery reason", () => {
      assert.strictEqual(w.deliveries, 3);
      assert.strictEqual(w.g.getSettings().stopped.length, 1);
      assert.ok(/could not be delivered/.test(w.g.getSettings().stopped[0].reason));
    });
  }
  // M2: task notifications / non-human origin do not reset the cap
  {
    const w = world();
    const origin = (ts, text, kind) => JSON.stringify({ type: "user", origin: { kind }, timestamp: iso(ts), message: { content: text } });
    const msgs = ["Next: a.", "Next: b.", "Next: c.", "Next: d."];
    const ts0 = w.t - 900000;
    let lines = [origin(ts0, "go", "human"), asst(ts0 + 1000, msgs[0])];
    w.set(lines); w.t = ts0 + 70000; await tick(w);
    for (let i = 1; i <= 3; i++) {
      lines = lines.concat([usr(w.t, "[hid:x] " + K.NUDGE_TEXT), origin(w.t + 500, "<task-notification>job done</task-notification>", "task-notification"), asst(w.t + 1000, msgs[i])]);
      w.set(lines); w.t += 100000; await tick(w);
    }
    t("M2: task-notification between nudges does not bypass the cap of 3", () => { assert.strictEqual(w.sent.length, 3); assert.strictEqual(w.g.getSettings().stopped.length, 1); });
    w.set(lines.concat([usr(w.t, "<task-notification>x</task-notification>")]));
    t("M2: parseTail marks prefix-only notification as not genuine", () => assert.strictEqual(K.parseTail(usr(1, "<task-notification>x</task-notification>")).lastHuman.systemish, true));
  }
  // M4: handoff in flight -> no nudge; M5: signature check before any tail read; L5: warm-up
  {
    const w = world();
    let active = true, reads = 0, sigv = "a";
    w.g = G.create({ now: () => w.t, log: (l) => w.logs.push(l), agents: () => ["A"], limits: { warmupMs: 0 }, handoffActive: () => active,
      sig: () => sigv, readTail: () => { reads++; return { text: w.lines.join("\n"), partialFirst: false, sig: sigv }; }, isWorking: () => false, readThrottle: () => null,
      deliver: async (p, tx) => { w.sent.push(tx); return { delivered: true, via: "channel" }; }, storage: { load: () => null, save: () => {} } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    await tick(w);
    t("M4: no nudge while a handoff flow is active", () => assert.strictEqual(w.sent.length, 0));
    active = false; await tick(w, 1000);
    t("M4: nudged once the flow is over", () => assert.strictEqual(w.sent.length, 1));
    const before = reads;
    for (let i = 0; i < 5; i++) await tick(w, 1000);
    t("M5: unchanged transcript costs no tail read", () => assert.strictEqual(reads, before));
    const w2 = world({}); w2.g = G.create({ now: () => w2.t, log: () => {}, agents: () => ["A"], handoffActive: () => false, sig: () => "x",
      readTail: () => ({ text: w.lines.join("\n"), sig: "x" }), isWorking: () => false, readThrottle: () => null, deliver: async () => { w2.sent.push(1); return { delivered: true }; }, storage: { load: () => null, save: () => {} } });
    await tick(w2);
    t("L5: warm-up after app start: nobody judged in the first minutes", () => assert.strictEqual(w2.sent.length, 0));
  }
  // M3: recap after only reading the handoff is nudged; waiting-only handoff is not a mission
  {
    const RESX = "[hid:q] " + K.resumePromptText("P", { mission: true });
    const rd = (ts) => JSON.stringify({ type: "assistant", timestamp: iso(ts), message: { content: [{ type: "tool_use", name: "Read", input: {} }] } });
    const w = world({ file: "## LESSONS\n- a\n## OPEN NOW\n- finish X\n## STATE\nExact next step: do Y\n## KEY FACTS\nz" });
    w.g.resumeText("A", "P");
    w.set([usr(w.t - 400000, RESX), rd(w.t - 390000), res(w.t - 380000), asst(w.t - 300000, "I've read the handoff. Two items are open.")]);
    await tick(w);
    t("M3: recap after only reading the handoff gets a nudge", () => assert.strictEqual(w.sent.length, 1));
    const w3 = world({ file: "## LESSONS\n- a\n## OPEN NOW\n- Waiting for Iddo's go to push the branch\n## STATE\nExact next step: wait for Iddo's approval\n## KEY FACTS\nz" });
    const r3 = w3.g.resumeText("A", "P");
    t("M3: a handoff that only waits on Iddo is not a mission and does not say continue IMMEDIATELY", () => { assert.strictEqual(r3.mission, false); assert.ok(!/IMMEDIATELY/.test(r3.text)); });
  }
  // H1: a turn that started a background task / messaged another agent is waiting, not stalled
  {
    const w = world();
    const bg = (ts) => JSON.stringify({ type: "assistant", timestamp: iso(ts), message: { content: [{ type: "tool_use", name: "Bash", input: { run_in_background: true } }] } });
    w.set([usr(w.t - 400000, "go"), bg(w.t - 390000), res(w.t - 380000), asst(w.t - 300000, "Rendering.\n\nNext: running the QA pass.")]);
    await tick(w);
    t("H1: background task in the turn -> no nudge", () => assert.strictEqual(w.sent.length, 0));
    t("H1: nudge text does not claim nothing blocks the agent and mentions approval", () => { assert.ok(!/Nothing has blocked you/.test(K.NUDGE_TEXT)); assert.ok(/approval/.test(K.NUDGE_TEXT) && /BLOCKED:/.test(K.NUDGE_TEXT)); });
  }

  // second review: a delivery cancelled by a handoff is not a failure; a late-landing nudge is counted, never duplicated
  {
    const w = world();
    let mode = "abort", deliveries = 0;
    w.g = G.create({ now: () => w.t, log: (l) => w.logs.push(l), emit: () => {}, agents: () => ["A"], limits: { warmupMs: 0 },
      readTail: () => ({ text: w.lines.join("\n"), sig: "s" + w.sigN }), isWorking: () => false, readThrottle: () => null,
      deliver: async () => { deliveries++; return mode === "abort" ? { delivered: false, aborted: true } : { delivered: false, attempts: 3 }; },
      storage: { load: () => null, save: () => {} } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, END)]);
    await tick(w);
    t("cancelled-by-handoff delivery: rolled back, no failure count", () => { assert.strictEqual(w.g._state().counters.A.consecutive, 0); assert.ok(!/NOT confirmed/.test(w.logs.join("\n"))); });
    mode = "fail";
    await tick(w, 100000); // retry (deferred), delivery reported not confirmed
    const sentAt = w.t;
    // ...but the nudge really landed late: the transcript now ends with the nudge entry
    w.set(w.lines.concat([usr(sentAt + 5000, "[hid:z] " + K.NUDGE_TEXT)]));
    const before = deliveries;
    await tick(w, 200000);
    t("late-landing nudge is counted and not retried", () => { assert.strictEqual(deliveries, before); assert.strictEqual(w.g._state().counters.A.consecutive, 1); assert.ok(w.logs.some((l) => /landed late/.test(l))); });
  }

  // ---- v1.74.0 relentless mode
  {
    const RDONE = "Finished item 1.\n\nDONE: item 1 is complete";
    const w = world();
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, RDONE)]);
    await tick(w);
    t("plain mode: DONE is not nudged", () => assert.strictEqual(w.sent.length, 0));
    w.g.setRelentless("A", true); // per-agent order with the fleet switch OFF; evaluates the unchanged transcript again
    await tick(w);
    t("per-agent relentless (fleet off): DONE gets the next-project nudge", () => { assert.strictEqual(w.sent.length, 1); assert.strictEqual(w.sent[0].text, K.NEXT_PROJECT_TEXT); });
    t("relentless persisted in the saved state, old fields kept", () => { assert.deepStrictEqual(w.saved.relentless, { fleet: false, agents: { A: true } }); assert.strictEqual(w.saved.globalEnabled, true); });
    const s = w.g.snapshot("A");
    t("snapshot: relentless flag, latest why, decisions kept", () => {
      assert.strictEqual(s.relentless, true); assert.strictEqual(s.agentRelentless, true); assert.strictEqual(s.fleetRelentless, false);
      assert.strictEqual(s.why.kind, "next-project"); assert.strictEqual(s.why.verdict, "nudge"); assert.ok(s.decisions.length >= 2);
      assert.strictEqual(s.decisions[0].verdict, "done");
    });
    t("getSettings: relentless info + agent states", () => {
      const g = w.g.getSettings();
      assert.deepStrictEqual(g.relentless, { fleet: false, agents: ["A"] });
      assert.ok(g.agentStates.some((x) => x.agentPath === "A" && x.relentless));
    });
    // simulated restart: new create() with the saved state keeps the order
    const w2 = world({ saved: w.saved }); w2.t += 200000;
    w2.set([usr(w2.t - 400000, "go"), asst(w2.t - 300000, "Next report.\n\nBLOCKED: item 2 needs Iddo")]);
    await tick(w2);
    t("restart: relentless order survives, BLOCKED gets the next-project nudge", () => { assert.strictEqual(w2.g.relentlessFor("A"), true); assert.strictEqual(w2.sent.length, 1); assert.strictEqual(w2.sent[0].text, K.NEXT_PROJECT_TEXT); });
    t("restart: decisions survive", () => assert.ok(w2.g.snapshot("A").decisions.length >= 2));
    w.g.setRelentless("A", false);
    t("switching off removes it", () => assert.deepStrictEqual(w.saved.relentless, { fleet: false, agents: {} }));
  }
  {
    const w = world({ saved: { globalEnabled: false, agents: { A: { enabled: false } }, counters: {} } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "Report: all green.")]);
    w.g.setRelentless(null, true); await tick(w);
    t("fleet relentless implies keep-going even with old switches off", () => { assert.strictEqual(w.sent.length, 1); assert.strictEqual(w.g.snapshot("A").enabled, true); });
  }
  {
    // old state file without any relentless fields loads fine
    const w = world({ saved: { globalEnabled: true, agents: {}, mission: {}, counters: {} } });
    t("backward compatible state", () => { assert.strictEqual(w.g.relentlessFor("A"), false); assert.deepStrictEqual(w.g.getSettings().relentless, { fleet: false, agents: [] }); });
  }
  {
    // question ending: question variant of the text
    const w = world({ saved: { relentless: { fleet: true, agents: {} } } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "Should I use A or B?")]);
    await tick(w);
    t("relentless question: decide yourself text", () => { assert.strictEqual(w.sent.length, 1); assert.strictEqual(w.sent[0].text, K.NEXT_PROJECT_QUESTION_TEXT); });
  }
  // NOTHING-LEFT: stop in both modes, snapshot says out of projects, no nudge
  for (const rel of [false, true]) {
    const w = world(rel ? { saved: { relentless: { fleet: true, agents: {} } } } : {});
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "Checked the list.\n\nNOTHING-LEFT: every open task needs Iddo")]);
    await tick(w);
    t("NOTHING-LEFT stops (relentless=" + rel + "): no nudge, out of projects", () => {
      assert.strictEqual(w.sent.length, 0);
      const s = w.g.snapshot("A");
      assert.strictEqual(s.outOfProjects, true); assert.ok(/every open task/.test(s.outOfProjectsReason));
      assert.ok(/^NOTHING-LEFT/.test(s.why.reason));
    });
    w.set(w.lines.concat([usr(w.t, "ok, new job"), asst(w.t + 1000, "Next: starting it.")]));
    await tick(w, 5000);
    t("a person's message clears out-of-projects (" + rel + ")", () => assert.strictEqual(w.g.snapshot("A").outOfProjects, false));
  }
  // HOLD / usage hard stop win in relentless mode; SLOW does not stop it
  {
    const w = world({ throttle: "HOLD", saved: { relentless: { fleet: true, agents: {} } } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "DONE: x")]);
    await tick(w);
    t("relentless + HOLD: no nudge", () => { assert.strictEqual(w.sent.length, 0); assert.strictEqual(w.g.snapshot("A").why.reason, "fleet throttle is HOLD"); });
    const w2 = world({ throttle: "SLOW", saved: { relentless: { fleet: true, agents: {} } } });
    w2.set([usr(w2.t - 400000, "go"), asst(w2.t - 300000, "DONE: x")]);
    await tick(w2);
    t("relentless + SLOW: nudged", () => assert.strictEqual(w2.sent.length, 1));
  }
  {
    const w = world({ saved: { relentless: { fleet: true, agents: {} } } });
    let hard = true;
    w.g = G.create({ now: () => w.t, log: (l) => w.logs.push(l), emit: (p, s) => w.emitted.push(s), agents: () => ["A"], limits: { warmupMs: 0 }, usageHardStop: () => hard,
      readTail: () => ({ text: w.lines.join("\n"), partialFirst: false, sig: "s" + w.sigN }), isWorking: () => false, readThrottle: () => null,
      deliver: async (p, text) => { w.sent.push({ p, text }); return { delivered: true, via: "channel" }; }, storage: { load: () => w.saved, save: (o) => { w.saved = JSON.parse(JSON.stringify(o)); } } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "DONE: x")]);
    await tick(w);
    t("usage hard stop: no nudge, reason shown", () => { assert.strictEqual(w.sent.length, 0); assert.strictEqual(w.g.snapshot("A").why.reason, "usage hard stop (>=95%)"); });
    hard = false;
    await tick(w, 70000); await tick(w, 1000);
    t("usage hard stop lifted: the unchanged transcript is judged again and nudged", () => assert.strictEqual(w.sent.length, 1));
  }
  // external guard wins even in relentless mode
  {
    const w = world({ saved: { relentless: { fleet: true, agents: {} } } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "Report ready.\n\nNext: sending the report to the client.")]);
    await tick(w);
    t("relentless: announced send is never nudged", () => assert.strictEqual(w.sent.length, 0));
  }
  // caps are higher in relentless mode: 4 consecutive no-progress nudges do not stop it (plain mode stops at 3)
  for (const rel of [false, true]) {
    const w = world(rel ? { saved: { relentless: { fleet: true, agents: {} } } } : {});
    let lines = [usr(w.t - 900000, "go"), asst(w.t - 890000, "Report 0: done.")];
    w.set(lines); await tick(w);
    for (let i = 1; i <= 5; i++) {
      lines = lines.concat([usr(w.t, "[hid:x] " + (rel ? K.NEXT_PROJECT_TEXT : K.NUDGE_TEXT)), asst(w.t + 1000, "Report " + i + ": done.")]);
      w.set(lines); w.t += 100000; await tick(w);
    }
    t("caps (relentless=" + rel + ")", () => {
      if (rel) { assert.strictEqual(w.sent.length, 6); assert.strictEqual(w.g.getSettings().stopped.length, 0); }
      else { assert.strictEqual(w.sent.length, 0); }
    });
  }
  {
    // plain mode cap check on announcements: stops at 3; relentless with the same stream does not
    const msgs = (i) => "Next: step " + i + ".";
    for (const rel of [false, true]) {
      const w = world(rel ? { saved: { relentless: { fleet: true, agents: {} } } } : {});
      let lines = [usr(w.t - 900000, "go"), asst(w.t - 890000, msgs(0))];
      w.set(lines); await tick(w);
      for (let i = 1; i <= 5; i++) {
        lines = lines.concat([usr(w.t, "[hid:x] " + K.NUDGE_TEXT), asst(w.t + 1000, msgs(i))]);
        w.set(lines); w.t += 100000; await tick(w);
      }
      t("consecutive cap: plain 3, relentless higher (relentless=" + rel + ")", () => {
        if (rel) { assert.strictEqual(w.sent.length, 6); assert.strictEqual(w.g.getSettings().stopped.length, 0); }
        else { assert.strictEqual(w.sent.length, 3); assert.strictEqual(w.g.getSettings().stopped.length, 1); }
      });
    }
  }
  {
    // relentless cap 12 consecutive: stopped after 12
    const w = world({ saved: { relentless: { fleet: true, agents: {} } } });
    let lines = [usr(w.t - 9000000, "go"), asst(w.t - 8990000, "Report 0: done.")];
    w.set(lines); await tick(w);
    for (let i = 1; i <= 16; i++) {
      lines = lines.concat([usr(w.t, "[hid:x] " + K.NEXT_PROJECT_TEXT), asst(w.t + 1000, "Report " + i + ": done.")]);
      w.set(lines); w.t += 100000; await tick(w);
    }
    t("relentless: stops after 12 consecutive nudges that did not help", () => { assert.strictEqual(w.sent.length, 12); assert.strictEqual(w.g.getSettings().stopped.length, 1); });
  }
  {
    // decisions ring: only changes stored, at most 20, persisted, not growing
    const w = world({ saved: { relentless: { fleet: true, agents: {} } } });
    w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "Report: x.")]);
    for (let i = 0; i < 5; i++) { w.sigN++; await tick(w, 1000); }
    const same = w.g.snapshot("A").decisions.length;
    t("unchanged decisions are not stored again", () => assert.ok(same <= 3));
    for (let i = 0; i < 30; i++) { w.set([usr(w.t - 400000, "go"), asst(w.t - 300000, "DONE: reason " + i)]); await tick(w, 1000); }
    t("decision ring is capped at 20", () => { assert.strictEqual(w.g.snapshot("A").decisions.length, 20); assert.ok(w.saved.decisions.A.length <= 20); });
  }
  {
    // resume text in relentless mode, even if the handoff declares BLOCKED
    const w = world({ saved: { relentless: { fleet: false, agents: { A: true } } }, file: "## LESSONS\n- a\n## OPEN NOW\nBLOCKED: waiting for Iddo\n## STATE\ns\n## KEY FACTS\nz" });
    const r = w.g.resumeText("A", "P");
    t("relentless resume text ignores a BLOCKED handoff", () => { assert.strictEqual(r.mission, true); assert.ok(/keep-working-regardless/.test(r.text)); assert.ok(r.text.startsWith("[[HANDOFF-RESUME]] P")); });
  }

  console.log((n - fails) + "/" + n + " keepGoingGlue tests passed");
  process.exit(fails ? 1 : 0);
})();

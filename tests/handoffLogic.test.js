// Run: node tests/handoffLogic.test.js
const assert = require("assert");
const L = require("../src/handoffLogic");

// 1. the prompt is ONE short line, names the file and every section
const file = "D:\agents\A\handoff_latest.md";
const p = L.handoffPrompt(file);
assert.ok(!/\n/.test(p) && p.length < 220, "one short line, got " + p.length);
assert.ok(/memory, then write .* LAST/.test(p), "write the file LAST");
for (const w of ["LESSONS", "OPEN NOW", "STATE", "KEY FACTS", "Handoff saved", file]) assert.ok(p.includes(w), w);
assert.ok(L.handoffPrompt(file, { interrupted: true }).includes("in flight"));
assert.ok(!/\n/.test(L.nudgePrompt(file)) && L.nudgePrompt(file).length < 200);

// 2. file readiness: all four headings with content
const good = "# Handoff 2026-10-03\n## LESSONS\n- a thing worth knowing\n## OPEN NOW\n- x\n## STATE\nmid-task, next step y\n## KEY FACTS\nfacts here\n";
assert.strictEqual(L.fileReady(good), true);
assert.strictEqual(L.fileReady(good.replace("## STATE", "## STAT")), false);
assert.strictEqual(L.fileReady("# Handoff\n"), false);
assert.strictEqual(L.fileReady(""), false);

// 3. estimate from recent durations (median of last 5), default 90
assert.strictEqual(L.estimateSecs([]), 90);
assert.strictEqual(L.estimateSecs([40, 60, 200]), 60);
assert.strictEqual(L.estimateSecs([1, 99999, "x", 50]), 50);
assert.strictEqual(L.estimateSecs([10, 20, 30, 40, 50, 60, 70]), 50); // last five: 30..70 -> median 50

// 4. progress text: stages, countdown, held count
assert.ok(/~45 s left/.test(L.progressText("writing", 15, 60, 0)));
assert.ok(/taking longer than usual/.test(L.progressText("writing", 200, 60, 0)));
assert.ok(/Your 2 messages are kept/.test(L.progressText("delivering", 0, 60, 2)));
assert.ok(/Your 1 message is kept/.test(L.progressText("ready", 0, 60, 1)));
assert.ok(/starting a fresh session/.test(L.progressText("resetting", 0, 60, 0)));

// 5. user messages typed during a handoff survive an app restart, in order, and are not duplicated
const held = new Map([["D:\agents\A", { items: ["first", "second"], at: 123 }], ["D:\agents\B", { items: [], at: 1 }]]);
const json = L.serializeHeld(held);
assert.ok(!json.includes("agents\\B"), "empty lists are not stored");
const back = L.parseHeld(json);
assert.deepStrictEqual(back.get("D:\agents\A").items, ["first", "second"]);
assert.strictEqual(back.get("D:\agents\A").at, 0, "loaded items count as old so the restore tick delivers them");
assert.strictEqual(back.size, 1);
assert.strictEqual(L.parseHeld("not json").size, 0);
assert.strictEqual(L.parseHeld('{"x":{"items":[1,null,"ok"]}}').get("x").items.length, 1);

console.log("handoffLogic ok");

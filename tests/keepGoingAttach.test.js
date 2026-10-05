// v1.75.0 tests: keep-going auto-attach (src/keepGoingAttach.js). Run: node tests/keepGoingAttach.test.js
"use strict";
const assert = require("assert");
const A = require("../src/keepGoingAttach");

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  pending.push((async () => {
    try { await fn(); pass++; } catch (e) { fail++; console.log("FAIL " + name + "\n  " + (e && e.message)); }
  })());
}

function world(o = {}) {
  const w = {
    now: 1e12, calls: { claim: [], release: [], attach: [], findAlive: [], dispatch: [] }, logs: [],
    attached: new Set(o.attached || []), spawning: new Set(o.spawning || []),
    alive: o.alive || {}, attachFails: !!o.attachFails, blocked: !!o.blocked,
  };
  w.g = A.create({
    now: () => w.now, log: (m) => w.logs.push(m),
    fleet: () => !!o.fleet, relentlessAgents: () => o.relentless || [], listed: () => o.listed || ["A", "B", "C"],
    attachedSet: () => w.attached, spawningSet: () => w.spawning, blocked: () => w.blocked,
    claim: (p) => { w.calls.claim.push(p); w.attached.add(p); },
    release: (p) => { w.calls.release.push(p); w.attached.delete(p); },
    findAlive: async (p) => { w.calls.findAlive.push(p); return w.alive[p] || null; },
    attach: async (p, id) => { w.calls.attach.push([p, id]); if (w.attachFails) throw new Error("[attach stage] timeout"); },
    dispatch: () => { w.calls.dispatch.push(1); }, // must never be reachable
  });
  return w;
}

t("candidates: only relentless agents unless the fleet switch is on", () => {
  const base = { listed: ["A", "B", "C"], attached: new Set(), spawning: new Set(), cooldown: new Map(), now: 1 };
  assert.deepStrictEqual(A.candidates(Object.assign({ fleet: false, relentlessAgents: ["B"] }, base)), ["B"]);
  assert.deepStrictEqual(A.candidates(Object.assign({ fleet: true, relentlessAgents: ["B"] }, base)), ["B", "A", "C"]);
  assert.deepStrictEqual(A.candidates(Object.assign({ fleet: false, relentlessAgents: [] }, base)), []);
});
t("candidates: skips attached, spawning, cooling down and deleted agents", () => {
  const c = { fleet: true, relentlessAgents: ["Gone"], listed: ["A", "B", "C", "D"], attached: new Set(["A"]), spawning: new Set(["B"]), cooldown: new Map([["C", 100]]), now: 50 };
  assert.deepStrictEqual(A.candidates(c), ["D"]);
  c.now = 200; assert.deepStrictEqual(A.candidates(c), ["C", "D"]);
});
t("a running agent is attached, one per tick, and never dispatched", async () => {
  const w = world({ relentless: ["A", "B"], alive: { A: { id: "ida" }, B: { id: "idb" } } });
  assert.strictEqual(await w.g.tick(), "attached");
  assert.deepStrictEqual(w.calls.attach, [["A", "ida"]]);
  assert.strictEqual(await w.g.tick(), "attached");
  assert.deepStrictEqual(w.calls.attach, [["A", "ida"], ["B", "idb"]]);
  assert.strictEqual(await w.g.tick(), "none");
  assert.strictEqual(w.calls.dispatch.length, 0);
});
t("DUPLICATE GUARD: no running background agent => nothing started, placeholder released, long cooldown", async () => {
  const w = world({ relentless: ["A"], alive: {} });
  assert.strictEqual(await w.g.tick(), "not-running");
  assert.strictEqual(w.calls.attach.length, 0);
  assert.strictEqual(w.calls.dispatch.length, 0);
  assert.deepStrictEqual(w.calls.claim, ["A"]); assert.deepStrictEqual(w.calls.release, ["A"]);
  assert.strictEqual(w.attached.has("A"), false);
  assert.ok(/NOT starting one/.test(w.logs[0]));
  assert.strictEqual(await w.g.tick(), "none"); // cooling down: not asked again
  w.now += A.COOLDOWN_NOT_RUNNING_MS + 1;
  w.alive.A = { id: "ida" };
  assert.strictEqual(await w.g.tick(), "attached"); // started later by someone else: picked up
});
t("findAlive throwing counts as not running (never starts anything)", async () => {
  const w = world({ relentless: ["A"] });
  const g = A.create({ now: () => w.now, log: () => {}, fleet: () => false, relentlessAgents: () => ["A"], listed: () => ["A"],
    attachedSet: () => w.attached, spawningSet: () => w.spawning, claim: (p) => w.calls.claim.push(p), release: (p) => w.calls.release.push(p),
    findAlive: async () => { throw new Error("claude agents failed"); }, attach: async () => { w.calls.attach.push(1); } });
  assert.strictEqual(await g.tick(), "not-running"); assert.strictEqual(w.calls.attach.length, 0);
});
t("a failed attach releases the placeholder and backs off", async () => {
  const w = world({ relentless: ["A"], alive: { A: { id: "ida" } }, attachFails: true });
  assert.strictEqual(await w.g.tick(), "failed");
  assert.strictEqual(w.attached.has("A"), false);
  assert.strictEqual(await w.g.tick(), "none");
  w.now += A.COOLDOWN_FAILED_MS + 1; w.attachFails = false;
  assert.strictEqual(await w.g.tick(), "attached");
});
t("blocked (CPU hold / test mode) attaches nothing and does not even look", async () => {
  const w = world({ relentless: ["A"], alive: { A: { id: "ida" } }, blocked: true });
  assert.strictEqual(await w.g.tick(), "blocked");
  assert.strictEqual(w.calls.findAlive.length, 0); assert.strictEqual(w.calls.claim.length, 0);
});
t("an agent that already has a terminal is left alone", async () => {
  const w = world({ relentless: ["A"], attached: ["A"], alive: { A: { id: "ida" } } });
  assert.strictEqual(await w.g.tick(), "none");
  assert.strictEqual(w.calls.findAlive.length, 0);
});
t("overlapping ticks do not start two attaches", async () => {
  const w = world({ relentless: ["A", "B"], alive: { A: { id: "ida" }, B: { id: "idb" } } });
  const [r1, r2] = await Promise.all([w.g.tick(), w.g.tick()]);
  assert.deepStrictEqual([r1, r2].sort(), ["attached", "busy"]);
  assert.strictEqual(w.calls.attach.length, 1);
});

Promise.all(pending).then(() => {
  console.log(pass + "/" + (pass + fail) + " keepGoingAttach tests passed");
  process.exit(fail ? 1 : 0);
});

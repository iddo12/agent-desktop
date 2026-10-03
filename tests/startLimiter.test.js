// Run: node tests/startLimiter.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStartLimiter, holdIsActive, readHoldFile } = require("../src/startLimiter");

// ---- fake clock ----
function clock() {
  let t = 1_000_000;
  let timers = [];
  let id = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { id: ++id, at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { timers = timers.filter((x) => x !== h); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function make(extra = {}) {
  const c = clock();
  let hold = null;
  const lim = createStartLimiter({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, readHold: () => hold, ...extra });
  return { c, lim, setHold: (h) => { hold = h; } };
}

(async () => {
  // --- concurrency cap, one start per 4 s, FIFO ---
  {
    const { c, lim } = make();
    const order = [];
    const rel = [];
    for (let i = 1; i <= 7; i++) lim.acquire({ label: "a" + i }).then((r) => { order.push("a" + i); rel.push(r); });
    await c.advance(1);
    assert.deepStrictEqual(order, ["a1"], "first start at once, the rest wait for the spacing");
    assert.strictEqual(lim.snapshot().queued, 6);
    assert.strictEqual(lim.snapshot().total, 7);
    await c.advance(4100);
    assert.deepStrictEqual(order, ["a1", "a2"], "second start after >= 4 s");
    await c.advance(4100);
    assert.deepStrictEqual(order, ["a1", "a2", "a3"]);
    await c.advance(20000);
    assert.deepStrictEqual(order, ["a1", "a2", "a3"], "cap of 3 in flight: nothing more until one finishes");
    rel.shift()(); // a1 finishes
    await flush();
    assert.deepStrictEqual(order, ["a1", "a2", "a3", "a4"], "slot free and spacing long past: next at once");
    rel.shift()();
    await flush();
    assert.strictEqual(order.length, 4, "spacing (4 s) not elapsed since a4");
    await c.advance(4100);
    assert.strictEqual(order.length, 5);
    rel.splice(0).forEach((r) => r());
    await c.advance(8200);
    assert.strictEqual(order.length, 7);
    assert.strictEqual(lim.snapshot().queued, 0);
    rel.splice(0).forEach((r) => r());
    assert.strictEqual(lim.snapshot().total, 0, "batch counters reset when idle");
    assert.strictEqual(lim.snapshot().inflight, 0);
  }

  // --- a start that never reports back frees its slot after 3 min (and logs it) ---
  {
    const { c, lim } = make({ maxConcurrent: 1, spacingMs: 1000 });
    const got = [];
    lim.acquire({ label: "hung" }).then(() => got.push("hung"));
    lim.acquire({ label: "next" }).then(() => got.push("next"));
    await c.advance(170000);
    assert.deepStrictEqual(got, ["hung"], "slot still held before the timeout");
    await c.advance(15000);
    assert.deepStrictEqual(got, ["hung", "next"], "slot freed by the timeout");
    assert.strictEqual(lim.snapshot().inflight, 1);
  }

  // --- first start is granted synchronously when idle (no 0 ms timer) ---
  {
    const { lim } = make();
    let g = false;
    lim.acquire({}).then(() => { g = true; });
    await flush();
    assert.ok(g, "idle limiter grants without waiting for a timer");
  }

  // --- never more than cap in flight even when nothing is released ---
  {
    const { c, lim } = make({ maxConcurrent: 2 });
    let n = 0;
    for (let i = 0; i < 5; i++) lim.acquire({}).then(() => n++);
    await c.advance(60000);
    assert.strictEqual(n, 2, "stuck starts never exceed the cap");
  }

  // --- run() releases on failure ---
  {
    const { lim } = make();
    await assert.rejects(lim.run(async () => { throw new Error("boom"); }, {}), /boom/);
    assert.strictEqual(lim.snapshot().inflight, 0);
  }

  // --- urgent never waits ---
  {
    const { c, lim, setHold } = make({ maxConcurrent: 1 });
    setHold({ hold: true, since: new Date(c.now()).toISOString() });
    let got = false;
    lim.acquire({ urgent: true }).then(() => { got = true; });
    await flush();
    assert.ok(got, "urgent bypasses hold and cap");
  }

  // --- hold blocks, resumes when the file disappears ---
  {
    const { c, lim, setHold } = make();
    const pad = (v) => String(v).padStart(2, "0");
    const dd = new Date(c.now());
    const since = `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}T${pad(dd.getHours())}:${pad(dd.getMinutes())}:${pad(dd.getSeconds())}`; // like Get-Date -Format s (local, zone-less)
    setHold({ hold: true, since, boxed: ["Security"], reason: "cpu" });
    let n = 0;
    lim.acquire({ label: "x" }).then(() => n++);
    await c.advance(30000);
    assert.strictEqual(n, 0, "held");
    assert.strictEqual(lim.snapshot().hold.active, true);
    assert.deepStrictEqual(lim.snapshot().hold.boxed, ["Security"]);
    setHold(null);
    await c.advance(5500);
    assert.strictEqual(n, 1, "released within one poll after the hold ended");
    assert.strictEqual(lim.snapshot().hold.active, false);
  }

  // --- hold polling is no faster than 2 s ---
  {
    let reads = 0;
    const c = clock();
    const lim = createStartLimiter({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, readHold: () => { reads++; return { hold: true, since: new Date(c.now()).toISOString() }; } });
    lim.acquire({});
    for (let i = 0; i < 5; i++) lim.acquire({}); // many pumps in the same instant
    await c.advance(10000);
    assert.ok(reads <= 3, "at most one read per 5 s (+first): " + reads);
  }

  // --- stale hold (since older than 30 min) is ignored ---
  {
    const { c, lim, setHold } = make();
    setHold({ hold: true, since: new Date(c.now() - 31 * 60000).toISOString() });
    let n = 0;
    lim.acquire({}).then(() => n++);
    await c.advance(1);
    assert.strictEqual(n, 1);
  }

  // --- safety timeout: a hold that never clears is abandoned after 15 min ---
  {
    const { c, lim, setHold } = make();
    let logged = "";
    const x = createStartLimiter({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, readHold: () => ({ hold: true, since: new Date(c.now()).toISOString() }), log: (m) => { logged += m; } });
    let n = 0;
    x.acquire({}).then(() => n++);
    await c.advance(14 * 60000);
    assert.strictEqual(n, 0);
    await c.advance(2 * 60000 + 6000);
    assert.strictEqual(n, 1, "proceeds after 15 min");
    assert.ok(/giving up waiting/.test(logged));
  }
})().catch((e) => { console.error(e); process.exit(1); });

// The tail above deliberately stays simple; spacing check for the abandoned-hold queue is covered below.
(async () => {
  const c = clock();
  const x = createStartLimiter({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, readHold: () => ({ hold: true, since: new Date(c.now()).toISOString() }), holdTimeoutMs: 20000 });
  let n = 0;
  const rels = [];
  x.acquire({}).then((r) => { n++; rels.push(r); });
  await c.advance(21000);
  assert.strictEqual(n, 1);
  x.acquire({}).then((r) => { n++; rels.push(r); });
  await c.advance(6000);
  assert.strictEqual(n, 2, "after the safety timeout the same file no longer blocks");

  // disabled switch
  const d = createStartLimiter({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, enabled: () => false, readHold: () => ({ hold: true, since: new Date(c.now()).toISOString() }) });
  let k = 0;
  for (let i = 0; i < 6; i++) d.acquire({}).then(() => k++);
  await flush();
  assert.strictEqual(k, 6, "limiterEnabled=false: everything passes at once");

  // ---- pure hold helpers ----
  const now = Date.parse("2026-10-03T12:00:00");
  assert.strictEqual(holdIsActive(null, now), false);
  assert.strictEqual(holdIsActive({ hold: true, since: "2026-10-03T11:50:00" }, now), true);
  assert.strictEqual(holdIsActive({ hold: true, since: "2026-10-03T11:20:00" }, now), false);
  assert.strictEqual(holdIsActive({ hold: false }, now), false);
  assert.strictEqual(holdIsActive({ hold: true }, now, 30 * 60000, now - 5 * 60000), true, "no since: use file mtime");
  assert.strictEqual(holdIsActive({ hold: true }, now, 30 * 60000, now - 45 * 60000), false);

  // ---- readHoldFile: missing / garbage / BOM json ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hold-"));
  const f = path.join(dir, "fleet_hold.json");
  assert.strictEqual(readHoldFile(f), null, "missing file = no hold");
  fs.writeFileSync(f, "{ not json");
  const bad = readHoldFile(f);
  assert.ok(bad && bad.hold && bad.unreadable, "unreadable file still holds (fresh mtime)");
  fs.writeFileSync(f, "﻿" + JSON.stringify({ hold: true, since: "2026-10-03T11:55:00", boxed: ["A"] }));
  const good = readHoldFile(f);
  assert.deepStrictEqual(good.boxed, ["A"]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("startLimiter ok");
})().catch((e) => { console.error(e); process.exit(1); });

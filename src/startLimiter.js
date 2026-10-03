// Start limiter (v1.66.0): keeps a crowd of `claude --bg` launches from hitting the CPU all at once.
//
// 2026-10-03: every agent was started together, CPU hit 100% and the mouse froze. Every session start in the
// app goes through dispatchBackgroundAgent() in main.js, which now asks this module for a slot first.
//
// Rules (pure logic, no Electron; time, timers and the hold-file reader are injected so it is unit-testable):
//   - at most `maxConcurrent` starts in flight at once (default 3);
//   - at least `spacingMs` (default 4 s) between one start and the next (starts are released one at a time);
//   - the queue is FIFO and visible through snapshot()/onChange (e.g. "Starting 5 of 19 agents");
//   - while the CPU guard's fleet_hold.json is active no new start is released. The hold is ignored when its
//     `since` is older than `staleMs` (30 min), and the wait is abandoned after `holdTimeoutMs` (15 min): a stale
//     file can never block the app for good. Once abandoned it is ignored until it has disappeared once;
//   - `urgent` requests (one explicit user action on one agent) never wait for anything;
//   - `enabled: () => false` turns the whole thing off at once (limiterEnabled setting).
// The hold file is read only while something is queued (or by refreshHold()), at most every `pollMs` (5 s).
// Timers exist only while starts are queued; an idle limiter has none.

"use strict";

const fs = require("fs");

const DEFAULTS = {
  maxConcurrent: 3,
  spacingMs: 4000,
  pollMs: 5000,
  holdTimeoutMs: 15 * 60 * 1000,
  staleMs: 30 * 60 * 1000,
  slotTimeoutMs: 3 * 60 * 1000, // a start that never reports back frees its slot after this
};

// info = parsed fleet_hold.json (or null). Pure: is this hold still to be honoured at `nowMs`?
function holdIsActive(info, nowMs, staleMs = DEFAULTS.staleMs, fileMtimeMs = null) {
  if (!info || typeof info !== "object") return false;
  if (info.hold === false) return false;
  let since = info.since ? Date.parse(info.since) : NaN; // CpuGuard writes local time without a zone ("Get-Date -Format s")
  if (!Number.isFinite(since)) since = fileMtimeMs;
  if (Number.isFinite(since) && nowMs - since > staleMs) return false;
  return true;
}

// Reads <stateDir>\fleet_hold.json. Returns the parsed info plus `mtimeMs`, or null when the file is missing.
// An unreadable or half-written file still counts as a hold ({ hold: true, unreadable: true }): the guard writes
// it non-atomically, and failing open here would defeat the hold for exactly the moment it was written.
function readHoldFile(file, fsImpl = fs) {
  let st;
  try {
    st = fsImpl.statSync(file);
  } catch (e) {
    return null;
  }
  let info = { hold: true, unreadable: true };
  try {
    const raw = String(fsImpl.readFileSync(file, "utf8")).replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") info = parsed;
  } catch (e) {
    /* keep the unreadable placeholder */
  }
  info.mtimeMs = st.mtimeMs;
  return info;
}

function createStartLimiter(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const now = o.now || (() => Date.now());
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  const readHold = o.readHold || (() => null);
  const enabled = o.enabled || (() => true);
  const log = o.log || (() => {});
  const onChange = o.onChange || (() => {});
  const maxConcurrent = () => Math.max(1, Number(typeof o.getMaxConcurrent === "function" ? o.getMaxConcurrent() : o.maxConcurrent) || DEFAULTS.maxConcurrent);

  const queue = []; // { label, urgent, grant }
  let inflight = 0;
  let lastWaveAt = -Infinity;
  let timer = null;
  let batchTotal = 0;
  let batchStarted = 0;
  let holdBlockedSince = null; // when we first had to wait for a hold
  let holdAbandoned = false; // safety timeout tripped; ignore the file until it disappears once
  let holdInfo = null; // last active hold (for the banner)
  let lastHoldCheck = -Infinity;
  let holdCached = false;
  let currentLabel = "";

  function resetBatchIfIdle() {
    if (!queue.length && inflight === 0) {
      batchTotal = 0;
      batchStarted = 0;
    }
  }

  // Is a hold blocking right now? Reads the file at most every pollMs.
  function holdBlocking() {
    const t = now();
    if (t - lastHoldCheck >= o.pollMs) {
      lastHoldCheck = t;
      let info = null;
      try {
        info = readHold();
      } catch (e) {
        info = null;
      }
      const active = holdIsActive(info, t, o.staleMs, info && info.mtimeMs);
      if (!active) {
        holdAbandoned = false;
        holdBlockedSince = null;
        holdInfo = null;
        holdCached = false;
      } else {
        holdInfo = info;
        holdCached = true;
      }
    }
    if (!holdCached) return false;
    if (holdAbandoned) return false;
    if (holdBlockedSince === null) holdBlockedSince = t;
    if (t - holdBlockedSince >= o.holdTimeoutMs) {
      holdAbandoned = true;
      log(`start limiter: fleet_hold.json still present after ${Math.round(o.holdTimeoutMs / 60000)} min - giving up waiting and proceeding`);
      return false;
    }
    return true;
  }

  function schedule(ms) {
    if (timer) clearT(timer);
    timer = setT(() => {
      timer = null;
      pump();
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function release(slot) {
    if (slot.released) return;
    slot.released = true;
    if (slot.timer) clearT(slot.timer);
    inflight = Math.max(0, inflight - 1);
    resetBatchIfIdle();
    changed();
    pump();
  }

  function makeSlot(label) {
    const slot = { released: false, timer: null };
    if (o.slotTimeoutMs > 0) {
      slot.timer = setT(() => {
        slot.timer = null;
        log(`start limiter: start of ${label} did not finish in ${Math.round(o.slotTimeoutMs / 1000)} s - freeing its slot`);
        release(slot);
      }, o.slotTimeoutMs);
      if (slot.timer && typeof slot.timer.unref === "function") slot.timer.unref();
    }
    return () => release(slot);
  }

  function grant(entry) {
    inflight++;
    batchStarted++;
    currentLabel = entry.label;
    entry.resolve(makeSlot(entry.label));
  }

  function pump() {
    if (!queue.length) {
      if (timer) {
        clearT(timer);
        timer = null;
      }
      changed();
      return;
    }
    if (!enabled()) {
      while (queue.length) grant(queue.shift());
      changed();
      return;
    }
    if (holdBlocking()) {
      changed();
      schedule(o.pollMs);
      return;
    }
    const t = now();
    const wait = lastWaveAt + o.spacingMs - t;
    if (inflight >= maxConcurrent() || wait > 0) {
      changed();
      // At the cap: a release will pump again. Spacing: wake when it has elapsed. Poll as a backstop.
      if (wait > 0) schedule(Math.min(wait, o.pollMs));
      else schedule(o.pollMs);
      return;
    }
    // One start per spacing interval, FIFO (a crowd of starts is what froze the PC).
    grant(queue.shift());
    lastWaveAt = t;
    changed();
    if (queue.length) schedule(Math.min(o.spacingMs, o.pollMs));
  }

  function changed() {
    try {
      onChange(snapshot());
    } catch (e) {
      /* UI hook must never break starts */
    }
  }

  function snapshot() {
    const holdActive = holdCached && !holdAbandoned;
    return {
      queued: queue.length,
      inflight,
      started: batchStarted,
      total: batchTotal,
      current: currentLabel,
      waiting: queue.map((q) => q.label),
      hold: holdActive
        ? { active: true, since: (holdInfo && holdInfo.since) || null, boxed: Array.isArray(holdInfo && holdInfo.boxed) ? holdInfo.boxed : [], reason: (holdInfo && holdInfo.reason) || "" }
        : { active: false, since: null, boxed: [], reason: "" },
    };
  }

  // Resolves with a release() function; the caller MUST call it when its start has finished (success or not).
  function acquire(opts = {}) {
    const label = opts.label || "agent";
    if (opts.urgent || !enabled()) {
      inflight++;
      return Promise.resolve(makeSlot(label));
    }
    return new Promise((resolve) => {
      queue.push({ label, resolve });
      batchTotal++;
      changed();
      // Granted at once when idle (no 0 ms timer); otherwise the spacing / release timers drive it.
      if (!timer) pump();
    });
  }

  // Convenience: run fn() inside a slot.
  async function run(fn, opts) {
    const done = await acquire(opts);
    try {
      return await fn();
    } finally {
      done();
    }
  }

  // Called by the app every pollMs so the banner shows even when nothing is queued. Emits only on a change.
  function refreshHold() {
    const before = JSON.stringify(snapshot().hold);
    lastHoldCheck = -Infinity;
    holdBlocking();
    if (JSON.stringify(snapshot().hold) !== before) changed();
    if (queue.length && !timer) pump();
  }

  function dispose() {
    if (timer) clearT(timer);
    timer = null;
  }

  return { acquire, run, snapshot, refreshHold, dispose, _pump: pump };
}

module.exports = { createStartLimiter, holdIsActive, readHoldFile, DEFAULTS };

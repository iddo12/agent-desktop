// Run: node tests/connectionHealth.test.js
const assert = require("assert");
const { create } = require("../src/connectionHealth");

function harness(over) {
  let t = 1000000;
  const timers = [];
  const events = [];
  const logs = [];
  const calls = { reconnect: 0, restart: 0, nudge: [] };
  const h = {
    sessions: {}, idleQuiet: true, working: false, interrupted: false, reconnectFails: 0, restartFails: 0, eligible: true,
  };
  Object.assign(h, over || {});
  const deps = {
    now: () => t,
    setTimeout: (fn, ms) => { const x = { fn, at: t + ms, dead: false }; timers.push(x); return x; },
    clearTimeout: (x) => { if (x) x.dead = true; },
    log: (l) => logs.push(l),
    emit: (p, s) => events.push(s),
    shouldRetry: () => h.eligible,
    sessionKind: (p) => h.sessions[p] || null,
    reconnect: async (p) => { calls.reconnect++; if (h.reconnectFails > 0) { h.reconnectFails--; throw new Error("agent timed out"); } h.sessions[p] = "real"; ch.onConnected(p); },
    restartSession: async (p) => { calls.restart++; if (h.restartHangs) return new Promise(() => {}); if (h.restartFails > 0) { h.restartFails--; throw new Error("dispatch failed"); } h.sessions[p] = "real"; },
    isIdleAndQuiet: () => h.idleQuiet,
    screenShows: () => !!h.screenShows,
    isWorking: () => h.working,
    wasInterrupted: () => h.interrupted,
    nudge: (p, text) => calls.nudge.push(text),
    // v1.68.0 stuck Enter
    inputHoldsText: () => !!h.holds,
    transcriptHas: () => (h.ack === undefined ? false : h.ack),
    pressEnter: (p) => { calls.enter = (calls.enter || 0) + 1; if (h.enterWorks) { h.holds = false; h.ack = true; } },
  };
  const ch = create(deps);
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      t = Math.max(t, due.at);
      due.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    t = end;
  }
  return { ch, h, events, logs, calls, advance, now: () => t };
}

(async () => {
  const P = "D:\\agents\\A";

  // 1. attach failure -> retries with growing backoff -> connected
  {
    const x = harness({ reconnectFails: 2 });
    assert.strictEqual(x.ch.onAttachFailed(P, "[attach stage] agent timed out", { cols: 100, rows: 30 }), true);
    assert.strictEqual(x.ch.getState(P).state, "reconnecting");
    await x.advance(9000); assert.strictEqual(x.calls.reconnect, 0);
    await x.advance(2000); assert.strictEqual(x.calls.reconnect, 1);          // t=11s (10s backoff)
    await x.advance(18000); assert.strictEqual(x.calls.reconnect, 1);         // next one is 20s after the first
    await x.advance(3000); assert.strictEqual(x.calls.reconnect, 2);
    await x.advance(37000); assert.strictEqual(x.calls.reconnect, 2);         // then 40s
    await x.advance(2000); assert.strictEqual(x.calls.reconnect, 3);
    assert.strictEqual(x.ch.getState(P).state, "connected");
    assert.strictEqual(x.events[x.events.length - 1].state, "connected");
    await x.advance(10 * 60 * 1000); assert.strictEqual(x.calls.reconnect, 3); // no further timers once connected
  }

  // 2. backoff caps at 5 min and never gives up
  {
    const x = harness({ reconnectFails: 1000 });
    x.ch.onAttachFailed(P, "boom");
    await x.advance(60 * 60 * 1000);
    assert.ok(x.calls.reconnect >= 11 && x.calls.reconnect <= 16, "attempts in an hour: " + x.calls.reconnect);
    assert.strictEqual(x.ch.getState(P).state, "reconnecting");
  }

  // 3. not eligible (paused / deleted / quitting): module does not take over
  {
    const x = harness({ eligible: false });
    assert.strictEqual(x.ch.onAttachFailed(P, "x"), false);
    assert.strictEqual(x.events.length, 0);
  }

  // 4. dead link: write, no data, idle + quiet -> restart after 30 s, requeueSince = first write
  {
    const x = harness();
    x.h.sessions[P] = "real";
    const t0 = x.now();
    x.ch.noteWrite(P, "\x1b[200~hello");
    x.ch.noteWrite(P, "\x1b[201~");
    await x.advance(29000); assert.strictEqual(x.calls.restart, 0);
    await x.advance(2000); assert.strictEqual(x.calls.restart, 1);
    const restarting = x.events.find((e) => e.state === "restarting");
    assert.ok(restarting && restarting.requeueSince === t0);
    assert.strictEqual(x.events[x.events.length - 1].state, "connected");
  }

  // 5. echo within 30 s -> alive, no restart; a lone "\r" is not a message
  {
    const x = harness();
    x.ch.noteWrite(P, "\r");
    await x.advance(40000); assert.strictEqual(x.calls.restart, 0);
    x.h.screenShows = true; // typed text is on the CLI screen: live link (stuck-Enter case, not dead)
    x.ch.noteWrite(P, "\x1b[200~hi");
    await x.advance(60000); assert.strictEqual(x.calls.restart, 0);
  }

  // 6. agent working / transcript grew -> not a dead link
  {
    const x = harness({ idleQuiet: false });
    x.ch.noteWrite(P, "\x1b[200~hi");
    await x.advance(40000); assert.strictEqual(x.calls.restart, 0);
  }

  // 7. cap: 3 restarts per 15 min, then degraded (and no 4th restart), recovers after the window
  {
    const x = harness();
    x.h.sessions[P] = "real";
    for (let i = 0; i < 3; i++) { x.ch.noteWrite(P, "\x1b[200~m" + i); await x.advance(31000); }
    assert.strictEqual(x.calls.restart, 3);
    x.ch.noteWrite(P, "\x1b[200~m3"); await x.advance(31000);
    assert.strictEqual(x.calls.restart, 3);
    assert.strictEqual(x.ch.getState(P).state, "degraded");
    await x.advance(15 * 60 * 1000);
    x.ch.noteWrite(P, "\x1b[200~m4"); await x.advance(31000);
    assert.strictEqual(x.calls.restart, 4); // window rolled over: allowed again
  }

  // 8. restart that fails falls back to reconnect-with-backoff (no loop, no duplicate restarts)
  {
    const x = harness({ restartFails: 1 });
    x.h.sessions[P] = "real";
    x.ch.noteWrite(P, "\x1b[200~hi");
    await x.advance(31000);
    assert.strictEqual(x.calls.restart, 1);
    assert.strictEqual(x.ch.getState(P).state, "reconnecting");
    delete x.h.sessions[P];
    await x.advance(11000);
    assert.strictEqual(x.calls.reconnect, 1);
    assert.strictEqual(x.ch.getState(P).state, "connected");
    assert.strictEqual(x.calls.restart, 1);
  }

  // 9. nudge: once per 15 min, only if idle and attached; skipped if the agent already resumed itself
  {
    const x = harness({ interrupted: true });
    x.h.sessions[P] = "real";
    assert.strictEqual(x.ch.afterStuckRecovery(P, { wasWorking: true }), true);
    await x.advance(11000);
    assert.strictEqual(x.calls.nudge.length, 1);
    assert.ok(/carry on/i.test(x.calls.nudge[0]));
    assert.strictEqual(x.ch.afterStuckRecovery(P, { wasWorking: true }), false); // gap
    await x.advance(16 * 60 * 1000);
    x.h.working = true;
    x.ch.afterStuckRecovery(P, { wasWorking: true });
    await x.advance(11000);
    assert.strictEqual(x.calls.nudge.length, 1); // agent was already working: no nudge
    const y = harness({ interrupted: false });
    y.h.sessions[P] = "real";
    assert.strictEqual(y.ch.afterStuckRecovery(P, { wasWorking: false }), false); // never working, not interrupted
  }

  // 10. a "starting" session (someone else connecting) is waited for, not duplicated
  {
    const x = harness();
    x.ch.onAttachFailed(P, "x");
    x.h.sessions[P] = "starting";
    await x.advance(11000);
    assert.strictEqual(x.calls.reconnect, 0);
    x.h.sessions[P] = "real";
    await x.advance(25000);
    assert.strictEqual(x.ch.getState(P).state, "connected");
    assert.strictEqual(x.calls.reconnect, 0);
  }

  // 11. (review H2) key sequences never arm the dead-link check
  {
    const x = harness();
    x.h.sessions[P] = "real";
    for (const k of ["\x1b[A", "\x1b[B", "\x1b[H", "\x1b[I", "\x1b[O", "\x1b[<0;10;10M", "\x1bOP", "\r", "a", "ab"]) x.ch.noteWrite(P, k);
    await x.advance(60000); assert.strictEqual(x.calls.restart, 0);
    x.ch.noteWrite(P, "\x1b[200~hello"); await x.advance(31000); assert.strictEqual(x.calls.restart, 1);
  }

  // 12. (review M4) a hung restart times out into backoff; a non-real session is never restarted
  {
    const x = harness();
    x.h.sessions[P] = "real";
    x.h.restartHangs = true;
    x.ch.noteWrite(P, "\x1b[200~hi");
    await x.advance(31000);
    assert.strictEqual(x.ch.getState(P).state, "restarting");
    await x.advance(2 * 60 * 1000 + 1000);
    assert.strictEqual(x.ch.getState(P).state, "reconnecting");
    const y = harness();
    y.h.sessions[P] = "starting";
    y.ch.noteWrite(P, "\x1b[200~hi");
    await y.advance(31000);
    assert.strictEqual(y.calls.restart, 0);
    assert.ok(y.logs.some((l) => /skipped/.test(l)));
  }

  // 13. (v1.67.3) a delayed "connected" (input replay in progress) is not overtaken by a plain onConnected
  {
    const x = harness();
    x.ch.onAttachFailed(P, "x");
    x.ch.onConnected(P, { delayMs: 5000 });
    x.ch.onConnected(P);
    assert.strictEqual(x.ch.getState(P).state, "reconnecting");
    await x.advance(5100);
    assert.strictEqual(x.ch.getState(P).state, "connected");
  }
  // 14. (v1.68.0) stuck Enter: text in the input box, no transcript entry -> one automatic Enter, then verified
  {
    const x = harness();
    x.h.sessions[P] = "real"; x.h.holds = true; x.h.screenShows = true; x.h.enterWorks = true;
    x.ch.noteWrite(P, "\x1b[200~please read the status report now");
    await x.advance(7000); assert.strictEqual(x.calls.enter || 0, 0);          // not before stuckEnterMs
    await x.advance(2000); assert.strictEqual(x.calls.enter, 1);               // Enter pressed once
    await x.advance(60000); assert.strictEqual(x.calls.enter, 1);              // never a second time
    assert.strictEqual(x.calls.restart, 0);
    assert.ok(x.logs.some((l) => /stuck-enter/.test(l) && /delivered after/.test(l)));
  }
  // 15. already landed (transcript has it): no Enter at all
  {
    const x = harness();
    x.h.sessions[P] = "real"; x.h.holds = true; x.h.screenShows = true; x.h.ack = true;
    x.ch.noteWrite(P, "\x1b[200~please read the status report now");
    await x.advance(40000); assert.strictEqual(x.calls.enter || 0, 0);
  }
  // 16. text is NOT in the input box (not the user's draft, not ours): no Enter
  {
    const x = harness();
    x.h.sessions[P] = "real"; x.h.holds = false; x.h.screenShows = true;
    x.ch.noteWrite(P, "\x1b[200~please read the status report now");
    await x.advance(40000); assert.strictEqual(x.calls.enter || 0, 0); assert.strictEqual(x.calls.restart, 0);
  }
  // 17. Enter did not help and the agent is idle: falls back to the dead-link recovery (restart + requeue), once
  {
    const x = harness();
    x.h.sessions[P] = "real"; x.h.holds = true; x.h.screenShows = true; x.h.enterWorks = false; x.h.working = false;
    x.ch.noteWrite(P, "\x1b[200~please read the status report now");
    await x.advance(8000 + 6000 + 1000);
    assert.strictEqual(x.calls.restart, 0);                                    // first verify only re-checks (slow transcript)
    await x.advance(6000);
    assert.strictEqual(x.calls.enter, 1);
    assert.strictEqual(x.calls.restart, 1);
    assert.ok(x.logs.some((l) => /stuck Enter/.test(l)));
    await x.advance(5 * 60 * 1000); assert.strictEqual(x.calls.enter, 1);
  }
  // 18. Enter did not help but the agent is working: no restart (never interrupt a working agent)
  {
    const x = harness();
    x.h.sessions[P] = "real"; x.h.holds = true; x.h.screenShows = true; x.h.working = true; x.h.idleQuiet = false;
    x.ch.noteWrite(P, "\x1b[200~please read the status report now");
    await x.advance(60000);
    assert.strictEqual(x.calls.enter, 1); assert.strictEqual(x.calls.restart, 0);
  }

  // 19. v1.68.2 B3: a message written in the seconds before an attach failure is noticed is handed back (requeueSince)
  {
    const x = harness();
    x.h.sessions[P] = "real";
    const t0 = x.now();
    x.ch.noteWrite(P, "\x1b[200~typed just before the pty died");
    await x.advance(9000);
    assert.strictEqual(x.ch.onAttachFailed(P, "attach exited"), true);
    const ev = x.events[x.events.length - 1];
    assert.strictEqual(ev.state, "reconnecting");
    assert.strictEqual(ev.requeueSince, t0, "the unacked write is requeued");
    await x.advance(60000);
    assert.strictEqual(x.calls.restart, 0, "the cleared dead-link timer must not restart a second time");
  }
  // 20. ... but not when the transcript already has it (it landed: re-sending would duplicate)
  {
    const x = harness();
    x.h.sessions[P] = "real"; x.h.ack = true;
    x.ch.noteWrite(P, "\x1b[200~this one already landed in the transcript");
    await x.advance(3000);
    x.ch.onAttachFailed(P, "attach exited");
    assert.strictEqual(x.events[x.events.length - 1].requeueSince, null);
  }

  console.log("connectionHealth ok");
})().catch((e) => { console.error(e); process.exit(1); });

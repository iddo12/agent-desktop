// v1.75.0: keep-going can only judge (and nudge) an agent the app has a terminal on. After an app restart those terminals
// are attached gradually, as agents are opened, so an agent Iddo never opens after a restart is never nudged even with
// "Keep working regardless" ON. This module attaches such agents, one at a time, in the background.
//
// DUPLICATE GUARD (the point of the design): it only ever attaches to a background agent that is ALREADY RUNNING
// (deps.findAlive). It never dispatches a new one. No running agent for the folder = skip, log, retry much later.
// All I/O is injected, so tests prove that nothing is started when nothing is found (tests/keepGoingAttach.test.js).
"use strict";

const COOLDOWN_NOT_RUNNING_MS = 30 * 60 * 1000; // no running background agent found: do not ask again for this long
const COOLDOWN_FAILED_MS = 10 * 60 * 1000;      // attach failed or timed out

// Pure: which agents should we try to attach to, in order? One entry at most is used per call by the caller.
// c: { fleet, relentlessAgents[], listed[] (all agent paths), attached (Set of paths with a pty session or placeholder),
//      spawning (Set of paths with an attach in progress), cooldown (Map path -> until ms), now }
function candidates(c) {
  const want = c.fleet ? Array.from(new Set([...(c.relentlessAgents || []), ...(c.listed || [])])) : (c.relentlessAgents || []);
  const known = new Set((c.listed || []).map(String));
  return want.filter((p) => {
    if (!known.has(String(p))) return false;               // an agent that no longer exists
    if (c.attached.has(p) || c.spawning.has(p)) return false;
    if ((c.cooldown.get(p) || 0) > c.now) return false;
    return true;
  });
}

function create(deps) {
  const cooldown = new Map();
  let busy = false;
  const now = () => (deps.now ? deps.now() : Date.now());
  const log = (m) => { try { deps.log && deps.log("keepgoing-attach: " + m); } catch (e) { /* never break the tick */ } };

  // Attach to AT MOST ONE agent per call. Returns a short status string (for tests / logs).
  async function tick() {
    if (busy) return "busy";
    if (deps.blocked && deps.blocked()) return "blocked";   // CPU guard hold, test mode without live agents, ...
    let list;
    try {
      list = candidates({ fleet: !!deps.fleet(), relentlessAgents: deps.relentlessAgents() || [], listed: deps.listed() || [],
        attached: deps.attachedSet(), spawning: deps.spawningSet(), cooldown, now: now() });
    } catch (e) { return "error"; }
    if (!list.length) return "none";
    const p = list[0];
    busy = true;
    try {
      deps.claim(p);                                         // synchronous placeholder: nothing else may start this agent meanwhile
      let found = null;
      try { found = await deps.findAlive(p); } catch (e) { found = null; }
      if (!found || !found.id) {
        deps.release(p);
        cooldown.set(p, now() + COOLDOWN_NOT_RUNNING_MS);
        log(p + " - no running background agent found; NOT starting one (no duplicates). Open it in the app to start it.");
        return "not-running";
      }
      try {
        await deps.attach(p, found.id);
        log(p + " - attached to the running agent " + found.id + " so it can be nudged");
        return "attached";
      } catch (e) {
        deps.release(p);
        cooldown.set(p, now() + COOLDOWN_FAILED_MS);
        log(p + " - attach failed: " + (e && e.message ? String(e.message).slice(0, 160) : e));
        return "failed";
      }
    } finally { busy = false; }
  }

  return { tick, _cooldown: cooldown };
}

module.exports = { create, candidates, COOLDOWN_NOT_RUNNING_MS, COOLDOWN_FAILED_MS };

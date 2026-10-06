"use strict";
// v1.77.3: the 60 s approval-blocked scan of ~/.claude/jobs, split out so it can be unit-tested.
// Two changes vs the inline version in main.js:
//  1. Per-agent decision AFTER the whole scan. Before, a stale non-blocked job file of the same agent that was read
//     after the blocked one (or before it, on the next pass) deleted the 90 s "waiting since" entry, so the threshold
//     was never reached and the Approve/Deny banner could not appear.
//  2. Cheap re-scans: job dirs whose state.json is older than 36 h are remembered and never stat'ed again; others are
//     re-read only when their mtime changed.
const fs = require("fs");
const path = require("path");

const MAX_AGE_MS = 36 * 3600 * 1000;

function createScanCache() { return { old: new Set(), parsed: new Map() }; }

function isApprovalBlocked(st) {
  return !!st && st.tempo === "blocked" && /^approve\b/i.test(String(st.needs || ""));
}

// accept(st) -> agentPath or null (fleet filter supplied by main.js). Returns Map agentPath -> { blocked: st|null }.
// When several job files of one agent are blocked, the one with the newest mtime wins.
function collectAgentJobStates(jobsDir, now, cache, accept, fsApi) {
  const f = fsApi || fs;
  let ids;
  try { ids = f.readdirSync(jobsDir); } catch (_) { return null; }
  const out = new Map();
  const liveIds = new Set();
  for (const id of ids) {
    if (cache.old.has(id)) continue;
    const file = path.join(jobsDir, id, "state.json");
    let mtimeMs, st;
    try {
      mtimeMs = f.statSync(file).mtimeMs;
      if (now - mtimeMs > MAX_AGE_MS) { cache.old.add(id); cache.parsed.delete(id); continue; }
      const c = cache.parsed.get(id);
      if (c && c.mtimeMs === mtimeMs) st = c.st;
      else { st = JSON.parse(f.readFileSync(file, "utf-8")); cache.parsed.set(id, { mtimeMs, st }); }
    } catch (_) { continue; }
    liveIds.add(id);
    if (!st) continue;
    const agentPath = accept(st);
    if (!agentPath) continue;
    let e = out.get(agentPath);
    if (!e) { e = { blocked: null, blockedMtime: 0 }; out.set(agentPath, e); }
    if (isApprovalBlocked(st) && mtimeMs >= e.blockedMtime) { e.blocked = st; e.blockedMtime = mtimeMs; }
  }
  for (const id of cache.parsed.keys()) if (!liveIds.has(id)) cache.parsed.delete(id);
  return out;
}

module.exports = { createScanCache, collectAgentJobStates, isApprovalBlocked, MAX_AGE_MS };

#!/usr/bin/env node
// Claude Code statusLine script, installed automatically by main.js's
// ensureRateLimitStatusLine() into ~/.claude/settings.json. Two jobs:
//
// 1. Render an actually useful status line for whoever is looking at a real
//    interactive `claude` terminal (model, folder, 5h/7d rate-limit usage,
//    context window usage) - this is a real user-facing feature on its own,
//    not just a means to an end.
// 2. Persist the same rate_limits data to RATE_LIMITS_CACHE_PATH, a shared
//    file Agent Desktop's own getUsageWindows() (see archive.js) reads to
//    show REAL account-wide rate-limit usage instead of the message-count
//    heuristic it otherwise has to fall back to. `rate_limits` is Anthropic's
//    own authoritative figure (Claude Code v2.1.80+, Pro/Max only, present
//    only after a session's first API response) - confirmed directly against
//    the official docs (https://code.claude.com/docs/en/statusline) before
//    building this, not guessed from a field name the way the original
//    "total_tokens_reminder" badge was (see CLAUDE.md's own writeup of that
//    mistake for why this project takes verifying field meaning seriously).
//
// Deliberately NOT scoped to Agent Desktop's own sessions only - ANY
// interactive `claude` session on this machine (a terminal Iddo opens
// himself, this very statusline running inside one) updates the same shared
// cache, since rate limits are account-wide regardless of which session
// triggers the API call that reveals them.
const fs = require("fs");
const path = require("path");
const os = require("os");

const RATE_LIMITS_CACHE_PATH = path.join(os.homedir(), ".claude", "agent-desktop-rate-limits.json");

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    process.stdout.write("");
    return;
  }

  const model = data.model && data.model.display_name;
  const dir = data.workspace && data.workspace.current_dir ? path.basename(data.workspace.current_dir) : "";
  const ctxPct = data.context_window && typeof data.context_window.used_percentage === "number"
    ? Math.round(data.context_window.used_percentage)
    : null;
  const rate = data.rate_limits || {};
  const fiveH = rate.five_hour && typeof rate.five_hour.used_percentage === "number" ? rate.five_hour.used_percentage : null;
  const sevenD = rate.seven_day && typeof rate.seven_day.used_percentage === "number" ? rate.seven_day.used_percentage : null;

  // Cache write happens regardless of whether this particular invocation has
  // fresh rate_limits data - a context-only update shouldn't erase the last
  // known rate-limit figures, since those windows update far less often than
  // context usage does.
  try {
    fs.mkdirSync(path.dirname(RATE_LIMITS_CACHE_PATH), { recursive: true });
    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(RATE_LIMITS_CACHE_PATH, "utf8"));
    } catch (e) {}
    if (fiveH !== null) {
      cache.fiveHourUsedPct = fiveH;
      cache.fiveHourResetsAt = rate.five_hour.resets_at || null;
    }
    if (sevenD !== null) {
      cache.sevenDayUsedPct = sevenD;
      cache.sevenDayResetsAt = rate.seven_day.resets_at || null;
    }
    if (fiveH !== null || sevenD !== null) {
      cache.updatedAt = new Date().toISOString();
      fs.writeFileSync(RATE_LIMITS_CACHE_PATH, JSON.stringify(cache));
    }
  } catch (e) {
    // Never let a cache-write failure blank out the actual status line.
  }

  // Per-session freshness record (added 2026-09-23 by the Optimization agent). The shared
  // cache above is re-written every refreshInterval by EVERY open session, including idle
  // ones still holding a % they heard hours or days ago, so its updatedAt says nothing about
  // freshness and its value flips between sessions (seen: weekly 25% <-> 91%). A session's
  // value only CHANGES when it makes an API call, so recording per session when its value
  // last changed lets a reader pick the genuinely fresh one. Additive: the cache above is
  // untouched. Read by UsageModel\sampler.js.
  try {
    const sid = data.session_id;
    if (sid && (fiveH !== null || sevenD !== null)) {
      const p = path.join(os.homedir(), ".claude", "agent-desktop-rate-limits-by-session.json");
      let m = {};
      try { m = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
      const now = new Date().toISOString();
      const cur = { p5: fiveH, r5: fiveH !== null ? rate.five_hour.resets_at || null : null, p7: sevenD, r7: sevenD !== null ? rate.seven_day.resets_at || null : null };
      const prev = m[sid];
      const changed = !prev || prev.p5 !== cur.p5 || prev.p7 !== cur.p7 || prev.r5 !== cur.r5 || prev.r7 !== cur.r7;
      m[sid] = Object.assign(cur, { seenAt: now, changedAt: changed ? now : prev.changedAt, firstSeenAt: prev ? prev.firstSeenAt : now });
      const cutoff = Date.now() - 8 * 86400000;
      for (const k of Object.keys(m)) if (!(Date.parse(m[k].seenAt) > cutoff)) delete m[k];
      const tmp = p + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(m));
      fs.renameSync(tmp, p);
    }
  } catch (e) {}

  const parts = [];
  if (model) parts.push(model);
  if (dir) parts.push(dir);
  if (ctxPct !== null) parts.push("ctx " + ctxPct + "%");
  if (fiveH !== null) parts.push("5h " + Math.round(fiveH) + "%");
  if (sevenD !== null) parts.push("7d " + Math.round(sevenD) + "%");
  process.stdout.write(parts.join(" · "));
});

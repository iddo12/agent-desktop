"use strict";
// v1.77.3: "log the first time per key per window, count the rest". Used for the repin "renamed back" watchdog line
// (300-860 per day, 48% of the log). The action being logged still happens every time; only the log line is throttled.
function createLogThrottle(everyMs) {
  const state = new Map(); // key -> { at, skipped }
  return {
    // Returns { log: true, skipped: n } when a line should be written now (n = lines suppressed since the last one),
    // else { log: false }.
    check(key, now) {
      const t = now == null ? Date.now() : now;
      const s = state.get(key);
      if (!s || t - s.at >= everyMs) {
        state.set(key, { at: t, skipped: 0 });
        return { log: true, skipped: s ? s.skipped : 0 };
      }
      s.skipped++;
      return { log: false };
    },
  };
}
module.exports = { createLogThrottle };

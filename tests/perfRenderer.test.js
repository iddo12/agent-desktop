// Run: node tests/perfRenderer.test.js
// v1.77.3: (1) the log throttle behind the repin "renamed back" line, (2) the cosmetic renderer pollers are gated on
// document.hidden while the guards sweep / unsent ledger / IRIS delivery keep running (source-level check: those files
// need a full Electron renderer to execute).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createLogThrottle } = require("../src/logThrottle");

const t = createLogThrottle(1000);
assert.deepStrictEqual(t.check("A", 0), { log: true, skipped: 0 }, "first time logs");
assert.deepStrictEqual(t.check("A", 10), { log: false });
assert.deepStrictEqual(t.check("A", 999), { log: false });
assert.deepStrictEqual(t.check("B", 20), { log: true, skipped: 0 }, "independent per key");
assert.deepStrictEqual(t.check("A", 1000), { log: true, skipped: 2 }, "after the window: log again with the skipped count");
assert.deepStrictEqual(t.check("A", 1500), { log: false });
assert.deepStrictEqual(t.check("A", 2100), { log: true, skipped: 1 });

const R = path.join(__dirname, "..", "src", "renderer");
const src = (f) => fs.readFileSync(path.join(R, f), "utf8");
const gated = [
  ["header-tasks.js", /setInterval\(\(\) => \{ if \(!document\.hidden\) refresh\(\); \}, POLL_MS\)/],
  ["library.js", /setInterval\(\(\) => \{ if \(!document\.hidden\) refresh\(\); \}, POLL_MS\)/],
  ["argus.js", /setInterval\(\(\) => \{ if \(!document\.hidden\) pollBadge\(\); \}, BADGE_MS\)/],
  ["approval-banner.js", /setInterval\(\(\) => \{ if \(!document\.hidden\) poll\(\); \}, 5000\)/],
  ["renderer.js", /setInterval\(\(\) => \{ if \(!document\.hidden\) chatViewStalePoll\(\); \}, CHAT_VIEW_STALE_POLL_MS\)/],
];
for (const [f, re] of gated) {
  const s = src(f);
  assert.ok(re.test(s), f + ": poll is gated on document.hidden");
  assert.ok(/visibilitychange/.test(s), f + ": catches up when the window becomes visible");
}
// must keep running while hidden
assert.ok(!/document\.hidden/.test(src("guards.js")), "guards sweep is not gated");
assert.ok(!/document\.hidden/.test(src("unsent-ledger.js")), "unsent ledger is not gated");
assert.ok(/setInterval\(deliverPending, POLL_MS\)/.test(src("iris.js")), "IRIS delivery is not gated");
// header panel renders only when open
const ht = src("header-tasks.js");
assert.ok(/function renderIfOpen\(\)/.test(ht) && /xp-panel-open"\)\) \{ panelDirty = false; render\(\)/.test(ht), "panel DOM rebuild only when open");
console.log("perfRenderer.test.js: all assertions passed");

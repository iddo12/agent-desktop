// Run: node tests/topbar.test.js
// v1.71.0 top-bar "Option B" guard. The repo has no DOM test harness, so this checks the contract statically:
// every element id the rest of the app writes to is still in index.html, the meter colour rule is exactly
// green <50 / amber 50-80 / red >80, the new stylesheet is linked last, and no dashed border / emoji came back.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error("FAIL: " + msg); } else console.log("ok:   " + msg); };

const html = rd("src/renderer/index.html");
const ids = ["chat-header", "chat-avatar-slot", "chat-header-text", "chat-name", "chat-role", "five-hour-usage", "weekly-usage",
  "monthly-usage", "context-usage", "model-badge", "cache-status", "reset-session-btn", "restart-session-btn", "pause-agent-btn",
  "raw-terminal-toggle-btn", "model-picker-btn", "chats-toggle-btn", "history-toggle-btn", "save-to-master-btn"];
ids.forEach((id) => ok(html.includes('id="' + id + '"'), "index.html keeps id " + id));
ok(/styles-keepgoing\.css[\s\S]*styles-topbar\.css/.test(html), "styles-topbar.css is linked after the other header styles");

const ht = rd("src/renderer/header-tasks.js");
const m = /function meterLevel\(pct\) \{[^}]*\}/.exec(ht);
ok(!!m, "meterLevel() present");
if (m) {
  const meterLevel = vm.runInNewContext("(" + m[0].replace("function meterLevel", "function") + ")");
  [[0, "ok"], [27, "ok"], [49, "ok"], [50, "warn"], [71, "warn"], [80, "warn"], [81, "crit"], [100, "crit"]]
    .forEach(([p, lvl]) => ok(meterLevel(p) === lvl, "meterLevel(" + p + ") = " + lvl));
}
["handoff-reset-btn", "handoff-all-btn", "reset-session-btn", "restart-session-btn", "pause-agent-btn", "model-picker-btn", "save-to-master-btn"]
  .forEach((id) => ok(ht.includes('"' + id + '"'), "Session menu still forwards to " + id));
ok(/five-hour-usage[\s\S]*weekly-usage[\s\S]*context-usage/.test(ht.slice(ht.indexOf("const METERS"))), "meters are 5h, 7d, Context in that order");

const css = rd("src/renderer/styles-topbar.css");
ok(!/dashed/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "styles-topbar.css has no dashed border (comments aside)");
const emoji = /[\u231B\u23F3\u2600-\u27BF\uD83C-\uDBFF]/;
["src/renderer/header-tasks.js", "src/renderer/keepgoing.js", "src/renderer/styles-topbar.css"].forEach((f) => ok(!emoji.test(rd(f)), f + " has no emoji"));
ok(/#five-hour-usage\.stale::after[^}]*content: none/.test(css), "stale hourglass is switched off");
ok(/@container topbar/.test(css), "narrow-window container queries present");

if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
console.log("topbar tests passed");

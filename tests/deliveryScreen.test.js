// Run: node tests/deliveryScreen.test.js
// Classifiers tested on REAL Claude Code screens (tests/fixtures/screens.json, captured from the CLI through node-pty).
const assert = require("assert");
const DS = require("../src/deliveryScreen");
const F = require("./fixtures/screens.json");

// main.js keeps the tail as the stripped stream; do the same here
const tailOf = (raw) => DS.stripTerminalCodes(raw).slice(-1500);
const SNIP = "and then summarise it";
const QSNIP = "reply with the single word TWO";

// stuck multi-line box (paste end marker lost; the CR became a newline: blank line after the text)
{
  const t = tailOf(F.stuck);
  assert.strictEqual(DS.inputHolds(t, SNIP), true);
  assert.strictEqual(DS.classify(t, SNIP, {}), "unsent-box");
  assert.strictEqual(DS.isDialog(t, SNIP), false);
  assert.strictEqual(DS.isQueued(t, SNIP), false);
}
// empty box
{
  const t = tailOf(F.empty);
  assert.strictEqual(DS.inputHolds(t, SNIP), false);
  assert.strictEqual(DS.classify(t, SNIP, {}), "box-empty-no-ack");
  assert.strictEqual(DS.ctrlCAgainShown(t), false);
}
// second Ctrl+C on an empty box shows the quit warning: the ladder must never go there
{
  const t = tailOf(F.ctrlCAgain);
  assert.strictEqual(DS.ctrlCAgainShown(t), true);
  assert.strictEqual(DS.inputHolds(t, SNIP), false);
}
// mid-turn paste queued by the CLI: shows as "> text" but is NOT an unsent box
{
  const t = tailOf(F.queued);
  assert.ok(/reply with the single word TWO/.test(t) || DS.squash(t).includes(DS.squash(QSNIP)), "fixture should contain the queued text");
  assert.strictEqual(DS.isQueued(t, QSNIP), true);
  assert.strictEqual(DS.inputHolds(t, QSNIP), false);
  assert.strictEqual(DS.classify(t, QSNIP, {}), "queued");
}
// tool permission dialog: never press Enter / run the ladder
{
  const t = tailOf(F.dialog);
  assert.strictEqual(DS.isDialog(t, ""), true);
  assert.strictEqual(DS.isDialog(t, "curl -s https://example.com -o ex.html"), true);
  assert.strictEqual(DS.inputHolds(t, "curl -s https://example.com -o ex.html"), false);
  assert.strictEqual(DS.classify(t, "anything typed", {}), "dialog");
}
// dead pty and working agent
assert.strictEqual(DS.classify(tailOf(F.stuck), SNIP, { deadPty: true }), "dead-pty");
assert.strictEqual(DS.classify(tailOf(F.empty), SNIP, { working: true }), "queued");
assert.strictEqual(DS.inputHolds("my text here\n esc to interrupt", "my text here"), false);
// a stale queued footer BEFORE the typed text does not hide a fresh unsent box
assert.strictEqual(DS.inputHolds("Press up to edit queued messages\n...\n> fresh text typed", "fresh text typed"), true);

// log helper: bounded, ANSI free
{
  const l = DS.lastLines(F.stuck, 25, 1500);
  assert.ok(l.length <= 1500 && !/\x1b/.test(l) && /summarise it/.test(l));
  assert.ok(DS.lastLines("x\n".repeat(5000), 25, 300).length <= 300);
}
// trailing backslash
assert.strictEqual(DS.fixTrailingBackslash("path C:\\temp\\"), "path C:\\temp\\ ");
assert.strictEqual(DS.fixTrailingBackslash("no slash"), "no slash");
assert.strictEqual(DS.fixTrailingBackslash("ends with space \\ "), "ends with space \\ ");
console.log("deliveryScreen ok");

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
assert.strictEqual(DS.classify(tailOf(F.empty), SNIP, { working: true }), "working"); // working is not "queued": a message that never landed must still raise the notice
assert.strictEqual(DS.inputHolds("my text here\n esc to interrupt", "my text here"), false);
// a stale queued footer BEFORE the typed text does not hide a fresh unsent box
assert.strictEqual(DS.inputHolds("Press up to edit queued messages\n...\n> fresh text typed", "fresh text typed"), true);

// log helper: bounded, ANSI free
{
  const l = DS.lastLines(F.stuck, 25, 1500);
  assert.ok(l.length <= 1500 && !/\x1b/.test(l) && !/summarise it/.test(l) && /\[box\]/.test(l) && /manual mode/.test(l), l); // the box content never reaches the log; footer/status stay
  assert.ok(DS.lastLines("x\n".repeat(5000), 25, 300).length <= 300);
}
// trailing backslash
assert.strictEqual(DS.fixTrailingBackslash("path C:\\temp\\"), "path C:\\temp\\ ");
assert.strictEqual(DS.fixTrailingBackslash("no slash"), "no slash");
assert.strictEqual(DS.fixTrailingBackslash("ends with space \\ "), "ends with space \\ ");

// v1.69.4 dead attach: liveness decision with fakes
{
  const now = 1000000;
  const base = { alive: true, now, attachedAt: now - 60000, dataBytes: 5000 };
  assert.strictEqual(DS.attachHealth(base), null);
  assert.strictEqual(DS.attachHealth(Object.assign({}, base, { alive: false })), "pty-gone");
  assert.strictEqual(DS.attachHealth(Object.assign({}, base, { dataBytes: 0 })), "no-output-since-attach");
  assert.strictEqual(DS.attachHealth(Object.assign({}, base, { dataBytes: 0, attachedAt: now - 3000 })), null); // fresh attach still drawing
}
// the stuck multi-line box fixture: Enter went in as a newline (text, blank line, rule)
assert.strictEqual(DS.stackedNewlines(tailOf(F.stuck), SNIP), true);
assert.strictEqual(DS.stackedNewlines(tailOf(F.empty), SNIP), false);
assert.strictEqual(DS.stackedNewlines("> text here\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500", "text here"), false); // normal box: one newline only
// dead attach: `claude logs` (the CLI is fine, text in its box) vs the attach screen being blank. The attach tail is empty,
// the logs text is the stuck fixture; classification names it dead-attach
{
  const logsText = DS.stripTerminalCodes(F.stuck);
  assert.ok(DS.hasSnippet(logsText, SNIP) && !DS.hasSnippet("", SNIP));
  assert.strictEqual(DS.classify("", SNIP, { deadAttach: "no-output-since-attach" }), "dead-attach");
  assert.strictEqual(DS.classify(tailOf(F.stuck), SNIP, { deadPty: true, deadAttach: "x" }), "dead-pty");
}

// v1.69.4 round 3: the queued footer counts only on the CURRENT screen
assert.strictEqual(DS.isQueued("> hello there\nPress up to edit queued messages", "hello there"), true);
assert.strictEqual(DS.isQueued("> hello there\nPress up to edit queued messages" + "\nmore output line\n".repeat(60), "hello there"), false); // stale footer, later output
// attach client evidence (experiment 2026-10-04): kicked = real capture, dashboard = synthesized from the observed strings
assert.strictEqual(DS.attachEvidence(tailOf(F.kicked)), "kicked");
assert.strictEqual(DS.attachEvidence(tailOf(F.dashboard)), "dashboard");
assert.strictEqual(DS.attachEvidence(tailOf(F.attachIdle)), null);   // a healthy idle attach screen is not evidence
assert.strictEqual(DS.attachEvidence(tailOf(F.stuck)), null);
assert.strictEqual(DS.attachEvidence(tailOf(F.ctrlCAgain)), null);   // "Press Ctrl-C again" alone is not a dead client
// blank attach vs `claude logs`: differ only when the logs show real content the attach screen lacks
{
  const logs = DS.stripTerminalCodes(F.attachIdle);
  assert.strictEqual(DS.screensDiffer("", logs), true);
  assert.strictEqual(DS.screensDiffer(tailOf(F.attachIdle), logs), false);
  assert.strictEqual(DS.screensDiffer("", "short\n"), false);
}
// logs: secrets redacted, the user's own text omitted
{
  const l = DS.lastLines("token=abc123supersecret\n> please read the status report now\nand then summarise it\nfooter", 25, 1500, "please read the status report now\nand then summarise it");
  assert.ok(!/abc123supersecret/.test(l) && !/status report/.test(l) && !/summarise it/.test(l) && /\[msg\]/.test(l) && /footer/.test(l), l);
  assert.ok(!/sk-[A-Za-z0-9]{20}/.test(DS.redactSecrets("key sk-ABCDEFGHIJKLMNOPQRST here")));
}

// round 4 privacy: a WRAPPED long message (CLI wrap + indent) and a spaces-stripped screen must not leak into the log
{
  const msg = "please email the quarterly invoice summary to the accountant and then archive the old thread so nothing is left in the inbox";
  const wrapped = "\u2500".repeat(30) + "\n\u276f please email the quarterly invoice summary to the\n  accountant and then archive the old thread so nothing\n  is left in the inbox\n" + "\u2500".repeat(30) + "\n  Haiku 4.5 \u00b7 status line";
  const l1 = DS.lastLines(wrapped, 25, 1500, msg);
  assert.ok(!/invoice|accountant|archive|inbox/.test(l1) && /Haiku/.test(l1), l1);
  const stripped = "some tool output\nplease" + "email" + "thequarterlyinvoicesummarytotheaccountant\nandthenarchivetheoldthread\nfooter line";   // cursor-forward moves ate the spaces; no box rules
  const l2 = DS.lastLines(stripped, 25, 1500, msg);
  assert.ok(!/invoice|archive/.test(l2) && /footer line/.test(l2) && /tool output/.test(l2), l2);
  // a draft sitting in the box with NO message known (Terminal-tab path) is masked too
  const l3 = DS.lastLines("\u2500".repeat(30) + "\nmy secret draft text\n" + "\u2500".repeat(30) + "\nstatus", 25, 1500);
  assert.ok(!/draft/.test(l3) && /status/.test(l3), l3);
}
// round 4 M1: an agent that merely PRINTS the phrases is not evidence (the CLI box / status follow it); a dead client's screen ends with them
{
  const printed = "I read the report: Session opened in another window and enter to return appear in it.\n" + "\u2500".repeat(40) + "\n\u276f \n" + "\u2500".repeat(40) + "\n  Haiku 4.5 \u00b7 status\n";
  assert.strictEqual(DS.attachEvidence(printed), null);
  assert.strictEqual(DS.attachEvidence("Session opened in another window\r\n" + "x ".repeat(200)), null); // more output after it: not the last thing on screen
  assert.strictEqual(DS.attachEvidence("\rSession opened in another window\r\n"), "kicked");
}
console.log("deliveryScreen ok");

// node tests/mailfeed.test.js - My Daily local mail feed (src/daily/mailfeed.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadMailFeed, normId } = require("../src/daily/mailfeed");
const DAY = 86400000;
const NOW = Date.parse("2026-10-06T10:00:00Z");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailfeed-"));
const put = (name, v) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v)); return f; };
let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
const item = (o) => Object.assign({ messageId: "<A@x>", direction: "received", date: new Date(NOW - 5 * DAY).toISOString(), account: "Local Folders", counterparty: "Bob <b@x.com>", subject: "Hi", folder: "Inbox" }, o);

t("maps received -> needAnswer and sent -> sentNoReply, oldest first", () => {
  const f = put("a.json", { generated: "2026-10-06T09:00:00Z", source: "betterbird", items: [item({ messageId: "1" }), item({ messageId: "2", date: new Date(NOW - 9 * DAY).toISOString() }), item({ messageId: "3", direction: "sent", daysWaiting: 4 })] });
  const r = loadMailFeed(f, NOW);
  assert.strictEqual(r.connected, true);
  assert.deepStrictEqual(r.emails.needAnswer.map((x) => x.id), ["2", "1"]);
  assert.strictEqual(r.emails.sentNoReply[0].ageDays, 4);
  assert.strictEqual(r.emails.sentNoReply[0].to, "Bob <b@x.com>");
  assert.deepStrictEqual(r.accounts, ["Betterbird"]);
});
t("dedupes by Message-ID (case and angle brackets), per direction", () => {
  assert.strictEqual(normId("<AbC@X>"), "abc@x");
  const f = put("b.json", { items: [item({ messageId: "<AbC@X>" }), item({ messageId: "abc@x" }), item({ messageId: "abc@x", direction: "sent" })] });
  const r = loadMailFeed(f, NOW);
  assert.strictEqual(r.emails.needAnswer.length, 1);
  assert.strictEqual(r.emails.sentNoReply.length, 1);
});
t("account labels: Local Folders -> Betterbird, 'x/y' -> y", () => {
  const f = put("c.json", { items: [item({ messageId: "1", account: "contact/editor@lensvid.com" }), item({ messageId: "2" })] });
  assert.deepStrictEqual(loadMailFeed(f, NOW).accounts, ["editor@lensvid.com", "Betterbird"]);
});
t("junk rows are skipped, text is cleaned and capped", () => {
  const f = put("d.json", { items: [null, 5, { messageId: "", direction: "sent", date: "x" }, item({ messageId: "9", subject: "a\u0000b\n" + "z".repeat(500) })] });
  const r = loadMailFeed(f, NOW);
  assert.strictEqual(r.emails.needAnswer.length, 1);
  assert.ok(r.emails.needAnswer[0].subject.length <= 200 && !/[\u0000\n]/.test(r.emails.needAnswer[0].subject));
});
t("missing, damaged, wrong-shaped or oversized feed -> not connected, never throws", () => {
  assert.strictEqual(loadMailFeed(path.join(tmp, "nope.json"), NOW).connected, false);
  assert.strictEqual(loadMailFeed(put("e.json", "{not json"), NOW).connected, false);
  assert.strictEqual(loadMailFeed(put("f.json", { items: "x" }), NOW).connected, false);
  assert.strictEqual(loadMailFeed(put("g.json", "[" + " ".repeat(5 * 1024 * 1024 + 10) + "]"), NOW).connected, false);
});
t("BOM is tolerated", () => {
  assert.strictEqual(loadMailFeed(put("h.json", "\uFEFF" + JSON.stringify({ items: [item({ messageId: "1" })] })), NOW).connected, true);
});
t("missing/empty daysWaiting falls back to the date, not 0", () => {
  const f = put("i.json", { items: [item({ messageId: "1", direction: "sent", daysWaiting: null }), item({ messageId: "2", direction: "sent", daysWaiting: "" })] });
  assert.deepStrictEqual(loadMailFeed(f, NOW).emails.sentNoReply.map((x) => x.ageDays), [5, 5]);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} of ${n} FAILED` : `mailfeed: ${n} tests passed`);
process.exit(fails ? 1 : 0);

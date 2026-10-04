// node tests/unsentLedger.test.js - unsent-message ledger (src/unsentLedger.js)
const assert = require("assert");
const L = require("../src/unsentLedger");

let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }

const NOW = 1_800_000_000_000;
const ub = (text, ts) => ({ role: "user", lines: [text], timestamp: new Date(ts).toISOString() });
const ctx = (o) => Object.assign({ now: NOW, blocks: [ub("earlier", NOW - 90000)], started: true, idleForMs: 60000, queued: [], pending: [] }, o);

t("delivered: exact user block after the send", () => assert(L.delivered([ub("hello", NOW)], { text: "hello", sentAt: NOW - 1000 })));
t("delivered: a block from BEFORE the send does not count", () => assert(!L.delivered([ub("hello", NOW - 60000)], { text: "hello", sentAt: NOW })));
t("delivered: agent reply never proves delivery", () => assert(!L.delivered([{ role: "assistant", lines: ["hello"], timestamp: new Date(NOW).toISOString() }], { text: "hello", sentAt: NOW - 1000 })));
t("delivered: short '?' needs its own block", () => assert(!L.delivered([ub("done", NOW)], { text: "?", sentAt: NOW - 1000 })));
t("delivered: long message merged into a bigger block (tail fingerprint)", () => {
  const msg = "x".repeat(40) + " this is the tail of a long message that survives a merge";
  assert(L.delivered([ub("other text " + msg, NOW)], { text: msg, sentAt: NOW - 1000 }));
});
t("delivered: pasted_content wrapper ignored", () => assert(L.delivered([ub('<pasted_content id="a1">abc def</pasted_content>', NOW)], { text: "abc def", sentAt: NOW - 1000 })));

t("decide: delivered -> drop", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 5000, disk: true }, ctx({ blocks: [ub("hi", NOW - 4000)] })), "drop"));
t("decide: expired -> drop", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - L.TTL_MS - 1, disk: true }, ctx()), "drop"));
t("decide: sent this run, unproven -> keep (manual Not-confirmed flow owns it)", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 90000 }, ctx()), "keep"));
t("decide: from disk, idle agent, transcript loaded, unproven -> recover", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 90000, disk: true }, ctx()), "recover"));
t("decide: from disk but agent not idle long enough -> keep", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 90000, disk: true }, ctx({ idleForMs: 5000 })), "keep"));
t("decide: from disk, transcript not loaded -> keep", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 90000, disk: true }, ctx({ blocks: [] })), "keep"));
t("decide: from disk, session not started -> keep", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 90000, disk: true }, ctx({ started: false })), "keep"));
t("decide: already in the visible queue -> drop (no duplicate)", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 90000, disk: true }, ctx({ queued: ["hi"] })), "drop"));
t("decide: user resent by hand -> drop (no duplicate)", () => assert.strictEqual(L.decide({ text: "hi", sentAt: NOW - 90000, disk: true }, ctx({ pending: ["hi"] })), "drop"));

t("serialize/parse round trip marks entries as from disk", () => {
  const m = new Map([["D:\\a", [{ text: "one", sentAt: NOW - 1000 }, { text: "", sentAt: NOW }]]]);
  const back = L.parse(L.serialize(m), NOW);
  assert.deepStrictEqual(back.get("D:\\a"), [{ text: "one", sentAt: NOW - 1000, disk: true }]);
});
t("parse: corrupt file gives an empty map", () => assert.strictEqual(L.parse("{not json", NOW).size, 0));
t("parse: drops entries older than the TTL", () => assert.strictEqual(L.parse(JSON.stringify({ a: [{ text: "x", sentAt: NOW - L.TTL_MS - 5 }] }), NOW).size, 0));

if (fails) { console.error(fails + " of " + n + " failed"); process.exit(1); }
console.log("unsentLedger tests passed (" + n + ")");

// Run: node tests/convMemo.test.js
// v1.77.3: listConversations per-file memo + getCurrentConversation (newest conversation only) must give the same answers
// as the old full parse of every transcript.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "adconv-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
const archive = require("../src/archive");
archive.setStatCacheTtl(0);
const cwd = path.join(home, "AgentC", ".claude-session");
const proj = path.join(home, ".claude", "projects", archive.encodeProjectPath(cwd));
fs.mkdirSync(proj, { recursive: true });
const iso = (ms) => new Date(ms).toISOString();
const T = Date.parse("2026-10-01T00:00:00.000Z");
const sid = (c) => c.repeat(8) + "-0000-0000-0000-" + c.repeat(12);
const human = (id, ms, text) => JSON.stringify({ type: "user", sessionId: id, timestamp: iso(ms), origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text }] } });
const write = (id, lines, mtimeOffset) => { const f = path.join(proj, id + ".jsonl"); fs.writeFileSync(f, lines.join("\n") + "\n"); const t = new Date(T + mtimeOffset); fs.utimesSync(f, t, t); return f; };

assert.deepStrictEqual(archive.listConversations(cwd), []);
assert.strictEqual(archive.getCurrentConversation(cwd), null, "no files = null");

const a = sid("a"), b = sid("b"), c = sid("c");
write(a, [human(a, T, "old one")], 1000);
write(b, [human(b, T + 5000, "middle"), human(b, T + 9000, "middle again")], 2000);
const fc = write(c, [JSON.stringify({ type: "agent-name", agentName: "x", sessionId: c })], 3000); // newest by mtime, no timestamps = no meta
const full = () => archive.listConversations(cwd);
const l1 = full();
assert.strictEqual(l1.length, 2);
assert.strictEqual(l1[0].sessionId, b);
assert.deepStrictEqual(archive.getCurrentConversation(cwd), l1[0], "newest file without a meta is skipped, same as the full list");
// memo: the second list call parses nothing and equals the first
let opens = 0; const realRead = fs.readFileSync;
fs.readFileSync = function (p) { if (String(p).endsWith(".jsonl")) opens++; return realRead.apply(fs, arguments); };
assert.deepStrictEqual(full(), l1);
assert.strictEqual(opens, 0, "unchanged files are not re-read");
// callers get copies: mutating the result must not leak into the memo
const l2 = full(); l2[1].isCurrent = true; l2[0].title = "mutated";
assert.deepStrictEqual(full(), l1, "memo is not mutated by callers");
// a changed file is re-parsed and re-ranked
fs.appendFileSync(path.join(proj, a + ".jsonl"), human(a, T + 20000, "old one wakes up") + "\n");
const l3 = full();
assert.strictEqual(l3[0].sessionId, a);
assert.ok(opens > 0, "the changed file was re-read");
assert.deepStrictEqual(archive.getCurrentConversation(cwd), l3[0]);
fs.readFileSync = realRead;
// replayed history: newer mtime but older timestamps does not win
write(b, [human(b, T + 5000, "middle"), human(b, T + 9000, "middle again")], 99000);
assert.strictEqual(archive.getCurrentConversation(cwd).sessionId, full()[0].sessionId, "ranking by timestamp, not mtime");
assert.strictEqual(archive.getCurrentConversation(cwd).isCurrent, true);
// a title appended to the live file shows (custom title wins) after the append
archive.setConversationTitle(cwd, a, "Renamed");
const cur = archive.getCurrentConversation(cwd);
assert.strictEqual(cur.title, "Renamed");
assert.strictEqual(cur.titleSource, "custom");
assert.deepStrictEqual(cur, full()[0]);
fs.unlinkSync(fc);
fs.rmSync(home, { recursive: true, force: true });
console.log("convMemo.test.js: all assertions passed");

// Run: node tests/archiveTailRank.test.js
// v1.76.0 archive.js: tail-ranked file selection (only the newest file(s) of a session folder are
// parsed), identical results to the full parse, and the persisted usage-scan cache round trip.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// archive.js finds transcripts under os.homedir()/.claude/projects - point HOME at a temp dir BEFORE requiring it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "adtail-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
const archive = require("../src/archive");

const cwd = path.join(home, "AgentX", ".claude-session");
const proj = path.join(home, ".claude", "projects", archive.encodeProjectPath(cwd));
fs.mkdirSync(proj, { recursive: true });

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const human = (ms, text) => JSON.stringify({ type: "user", uuid: "u" + seq++, sessionId: "s", timestamp: iso(ms), origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text }] } });
const reply = (ms, text, tokens) => JSON.stringify({ type: "assistant", uuid: "a" + seq++, sessionId: "s", timestamp: iso(ms), message: { role: "assistant", model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: tokens, output_tokens: 10 } } });
const toolTurn = (ms) => JSON.stringify({ type: "assistant", uuid: "a" + seq++, sessionId: "s", timestamp: iso(ms), message: { role: "assistant", model: "claude-x", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Read", input: {} }] } });
const untimed = () => JSON.stringify({ type: "agent-name", agentName: "AgentX", sessionId: "s" });

// old.jsonl: a big, old conversation (several hundred KB so its tail window is a real subset)
const oldLines = [];
for (let i = 0; i < 3000; i++) {
  oldLines.push(human(T0 + i * 60000, "question " + i + " " + "x".repeat(120)));
  oldLines.push(reply(T0 + i * 60000 + 1000, "answer " + i + " " + "y".repeat(120), 1000 + i));
}
fs.writeFileSync(path.join(proj, "old.jsonl"), oldLines.join("\n") + "\n");
// mid.jsonl: newer than old, but its last lines carry no timestamp (what setConversationTitle appends)
const M0 = T0 + 3000 * 60000 + 3600000;
fs.writeFileSync(path.join(proj, "mid.jsonl"), [human(M0, "mid q"), reply(M0 + 1000, "mid a", 5000), untimed(), untimed()].join("\n") + "\n");
// new.jsonl: the live one - newest, ends mid-turn (a tool_use with no result yet), last line unterminated
const N0 = M0 + 3600000;
fs.writeFileSync(path.join(proj, "new.jsonl"), [human(N0, "new q"), reply(N0 + 1000, "new a", 7000), human(N0 + 2000, "go on"), toolTurn(N0 + 3000)].join("\n") + "\n" + '{"type":"progress","timestamp":"' + iso(N0 + 4000) + '"');

// --- count what gets read: the old file must only ever be read in its tail window
const realOpen = fs.openSync;
const opened = [];
fs.openSync = function (p, ...rest) { opened.push(path.basename(String(p))); return realOpen.call(fs, p, ...rest); };
const realRead = fs.readSync;
let oldBytesRead = 0;
const oldPath = path.join(proj, "old.jsonl");
const fdOf = new Map();
const realOpen2 = fs.openSync;
fs.openSync = function (p, ...rest) { const fd = realOpen2.call(fs, p, ...rest); fdOf.set(fd, String(p)); return fd; };
fs.readSync = function (fd, buf, off, len, pos) { const n = realRead.call(fs, fd, buf, off, len, pos); if (fdOf.get(fd) === oldPath) oldBytesRead += n; return n; };

// --- ranking
const files = fs.readdirSync(proj).map((f) => path.join(proj, f));
const ranked = archive.__rankFilesByTailForTest(files).map((r) => path.basename(r.jsonlPath));
assert.deepStrictEqual(ranked, ["new.jsonl", "mid.jsonl", "old.jsonl"], "tail ranking newest first; untimestamped tail lines are skipped");
const tOld = archive.__tailLatestTsForTest(oldPath).ts;
assert.strictEqual(tOld, T0 + 2999 * 60000 + 1000, "old file's newest timestamp found in its tail");
assert.ok(oldBytesRead > 0 && oldBytesRead <= 64 * 1024, "old file read only in its 64 KB tail window, got " + oldBytesRead);

// --- readers agree with a brute-force full parse
const act = archive.__readActivitySummaryForTest(cwd);
assert.strictEqual(act.lastSessionId, "s");
assert.strictEqual(act.lastHumanTs, N0 + 2000, "last human message from the newest file");
assert.strictEqual(act.last.done, false, "ends mid tool_use = still working");
const usage = archive.getLatestUsage(cwd);
assert.strictEqual(usage.contextTokens, 7000, "latest usage comes from the newest file");
const blocks = archive.getLiveTranscriptBlocks(cwd);
assert.deepStrictEqual(blocks.map((b) => b.role + ":" + b.lines[0]), ["user:new q", "agent:new a", "user:go on", "status:[used tool: Read]"], "chat shows only the live file");
assert.ok(oldBytesRead <= 64 * 1024, "none of the three readers parsed the old file in full (" + oldBytesRead + " bytes read)");

// --- the newest file keeps being read incrementally; an older file that becomes newest again is parsed in full
fs.appendFileSync(path.join(proj, "new.jsonl"), "\n" + reply(N0 + 5000, "done", 7500) + "\n");
assert.strictEqual(archive.getLatestUsage(cwd).contextTokens, 7500);
assert.strictEqual(archive.__readActivitySummaryForTest(cwd).last.done, true);
fs.appendFileSync(oldPath, human(N0 + 9000, "resumed the old one") + "\n");
const blocks2 = archive.getLiveTranscriptBlocks(cwd);
assert.strictEqual(blocks2[blocks2.length - 1].lines[0], "resumed the old one", "old file is newest now and was parsed in full");
assert.strictEqual(blocks2.length, 6001, "all of the old file's blocks are there");
assert.strictEqual(archive.__readActivitySummaryForTest(cwd).lastHumanTs, N0 + 9000);
assert.strictEqual(archive.getLatestUsage(cwd).contextTokens, 7500, "usage stays at the newest assistant entry (in new.jsonl)");

// --- ties and unreadable files never throw
const r2 = archive.__rankFilesByTailForTest([path.join(proj, "missing.jsonl"), path.join(proj, "new.jsonl")]);
assert.strictEqual(path.basename(r2[0].jsonlPath), "new.jsonl");
assert.strictEqual(r2[1].ts, -Infinity);

// --- usage-scan cache: save, load into a fresh module copy, same answer, no bytes re-read
fs.openSync = realOpen2; fs.readSync = realRead;
const w1 = archive.getUsageWindows();
assert.ok(w1.messagesInLast7d >= 0);
const cacheFile = path.join(home, "usage-scan-cache.json");
assert.strictEqual(archive.isUsageFileCacheDirty(), true);
archive.saveUsageFileCache(cacheFile);
assert.strictEqual(archive.isUsageFileCacheDirty(), false);
delete require.cache[require.resolve("../src/archive")];
const archive2 = require("../src/archive");
assert.strictEqual(archive2.loadUsageFileCache(cacheFile), 3, "three file records restored");
let bytes2 = 0;
fs.readSync = function (fd, buf, off, len, pos) { const n = realRead.call(fs, fd, buf, off, len, pos); bytes2 += n; return n; };
const w2 = archive2.getUsageWindows();
fs.readSync = realRead;
assert.deepStrictEqual({ a: w2.messagesInLast7d, b: w2.monthly && w2.monthly.messagesThisMonth }, { a: w1.messagesInLast7d, b: w1.monthly && w1.monthly.messagesThisMonth });
assert.strictEqual(bytes2, 0, "warm scan read no transcript bytes");
assert.strictEqual(archive2.loadUsageFileCache(path.join(home, "nope.json")), 0, "missing cache = cold scan, no throw");

fs.rmSync(home, { recursive: true, force: true });
console.log("archiveTailRank.test.js: all assertions passed");

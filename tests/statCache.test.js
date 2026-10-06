// Run: node tests/statCache.test.js
// v1.77.3: shared stat/readdir cache (archive.js), getHaltInfo memo, readOpenItems memo, listAgents memo.
// Each cached answer must equal the uncached one, and a real change must show up after the TTL (or at once after invalidate).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "adstat-"));
const root = path.join(home, "root");
fs.mkdirSync(root);
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.AGENT_DESKTOP_ROOT = root;
const archive = require("../src/archive");
const overview = require("../src/overview");
const agents = require("../src/agents");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const cwd = path.join(root, "AgentZ", ".claude-session");
const proj = path.join(home, ".claude", "projects", archive.encodeProjectPath(cwd));
fs.mkdirSync(proj, { recursive: true });
const f1 = path.join(proj, "11111111-aaaa.jsonl");
const human = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-01T00:00:00.000Z", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "hi" }] } });
const halt = JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-10-01T00:00:05.000Z", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, quotaLimits: { rateLimitType: "five_hour", resetsAt: 1790000000 }, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "limit" }] } });
fs.writeFileSync(f1, human + "\n");

// ---- stat/readdir cache
archive.setStatCacheTtl(300);
let n = archive.newestTranscript(cwd);
assert.strictEqual(n.size, Buffer.byteLength(human + "\n"));
fs.appendFileSync(f1, halt + "\n");
assert.strictEqual(archive.newestTranscript(cwd).size, n.size, "within the TTL the cached stat is served");
sleep(350);
assert.strictEqual(archive.newestTranscript(cwd).size, fs.statSync(f1).size, "after the TTL a real change is visible");
// invalidate: a brand-new file appears at once
const f2 = path.join(proj, "22222222-bbbb.jsonl");
fs.writeFileSync(f2, human + "\n");
archive.invalidateStatCache();
assert.strictEqual(path.basename(archive.newestTranscript(cwd).jsonlPath), "22222222-bbbb.jsonl", "invalidate shows a new file immediately");
// TTL 0 = exactly the uncached behaviour
archive.setStatCacheTtl(0);
fs.appendFileSync(f2, human + "\n");
assert.strictEqual(archive.newestTranscript(cwd).size, fs.statSync(f2).size, "ttl 0 is uncached");
assert.strictEqual(archive.getLatestTranscriptSizeBytes(cwd), fs.statSync(f2).size);
assert.strictEqual(archive.getLatestTranscriptMtimeMs(cwd), fs.statSync(f2).mtimeMs);
fs.unlinkSync(f2);
assert.strictEqual(path.basename(archive.newestTranscript(cwd).jsonlPath), "11111111-aaaa.jsonl", "deleted file disappears (ttl 0)");

// ---- getHaltInfo memo: same answer as uncached, no re-read while unchanged, updates on change
archive.setStatCacheTtl(0);
const uncached = archive.getHaltInfo(cwd);
assert.ok(uncached && uncached.kind === "rate_limit", "halt detected");
let reads = 0;
const realRead = fs.readSync;
fs.readSync = function () { reads++; return realRead.apply(fs, arguments); };
assert.deepStrictEqual(archive.getHaltInfo(cwd), uncached);
assert.deepStrictEqual(archive.getHaltInfo(cwd), uncached);
assert.strictEqual(reads, 0, "unchanged file: tail not re-read");
fs.appendFileSync(f1, human.replace("u1", "u2") + "\n");
assert.strictEqual(archive.getHaltInfo(cwd), null, "a newer human message clears the halt (memo invalidated by size/mtime)");
assert.ok(reads > 0);
fs.readSync = realRead;

// ---- readOpenItems memo
const agentDir = path.join(root, "AgentZ");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "master_state.md"), "## Status\nok\n\n## OPEN NOW\n1. **First item that is rather long indeed**\n2. Second\n");
const a = overview.readOpenItems(agentDir);
assert.deepStrictEqual(a, overview.readOpenItemsUncached(agentDir));
assert.strictEqual(overview.readOpenItems(agentDir), a, "unchanged: same memoized object");
fs.writeFileSync(path.join(agentDir, "master_state.md"), "## Status\nok\n\n## OPEN NOW\n1. Only one now\n");
const b = overview.readOpenItems(agentDir);
assert.deepStrictEqual(b, overview.readOpenItemsUncached(agentDir));
assert.notDeepStrictEqual(a.items, b.items, "file change is picked up");
fs.writeFileSync(path.join(agentDir, "Active_Tasks.md"), "## OPEN NOW\n1. From active tasks\n");
assert.strictEqual(overview.readOpenItems(agentDir).file, "Active_Tasks.md", "a newly created higher-priority file is picked up");

// ---- listAgents memo
fs.writeFileSync(path.join(agentDir, "agent_config.json"), JSON.stringify({ display_name: "Zed", role: "r" }));
let l1 = agents.listAgents({ noAvatar: true });
assert.strictEqual(l1.length, 1);
assert.strictEqual(l1[0].displayName, "Zed");
assert.strictEqual(l1[0].status, "ok");
const l2 = agents.listAgents({ noAvatar: true });
assert.deepStrictEqual(l2, l1);
assert.notStrictEqual(l2[0], l1[0], "entries are fresh objects");
fs.writeFileSync(path.join(agentDir, "agent_config.json"), JSON.stringify({ display_name: "Zed2", role: "r", paused: true }));
fs.writeFileSync(path.join(agentDir, "master_state.md"), "## Status\nchanged\n\n## Health\nHealthy\n");
const l3 = agents.listAgents({ noAvatar: true });
assert.strictEqual(l3[0].displayName, "Zed2");
assert.strictEqual(l3[0].paused, true);
assert.strictEqual(l3[0].status, "changed");
assert.strictEqual(l3[0].healthLabel, "Healthy");
fs.unlinkSync(path.join(agentDir, "master_state.md"));
const l4 = agents.listAgents({ noAvatar: true });
assert.strictEqual(l4[0].hasState, false);
assert.strictEqual(l4[0].status, "No work plan yet");

fs.rmSync(home, { recursive: true, force: true });
console.log("statCache.test.js: all assertions passed");

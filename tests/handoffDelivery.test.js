// node tests/handoffDelivery.test.js  (also: npm test)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deliver, staleInfo } = require("../src/handoffDelivery");
const channel = require("../src/agentChannel");

let t = 0; // fake clock
const base = () => ({ now: () => t, sleep: async (ms) => { t += ms; }, log: () => {} });
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("channel acked and lands: no pty", async () => {
  t = 0; let pty = 0, lines = [];
  const r = await deliver("hi", { ...base(), log: (l) => lines.push(l), channelSend: async () => ({ ok: true }), ptySend: () => pty++, transcriptHas: async () => true });
  assert.deepStrictEqual([r.delivered, r.via, r.attempts, pty], [true, "channel", 1, 0]);
  assert.ok(lines.some((l) => /via message channel/.test(l)) && lines.some((l) => /landed/.test(l)));
});
test("channel unavailable: falls back to pty", async () => {
  t = 0; const sent = [];
  const r = await deliver("hi", { ...base(), channelSend: async () => ({ ok: false, reason: "x" }), ptySend: (b) => sent.push(b), transcriptHas: async () => true });
  assert.strictEqual(r.via, "pty"); assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].startsWith(r.marker + " hi"));
});
test("no channel at all: pty", async () => {
  t = 0; const r = await deliver("hi", { ...base(), ptySend: () => {}, transcriptHas: async () => true });
  assert.strictEqual(r.via, "pty");
});
test("not landing: retries with backoff then gives up, logs each attempt", async () => {
  t = 0; let pty = 0; const lines = [];
  const r = await deliver("hi", { ...base(), log: (l) => lines.push(l), ptySend: () => pty++, transcriptHas: async () => false });
  assert.deepStrictEqual([r.delivered, r.attempts, pty], [false, 3, 3]);
  assert.strictEqual(lines.filter((l) => /NOT in transcript/.test(l)).length, 3);
  assert.ok(t >= 8000 + 20000 + 45000);
});
test("lands on second attempt", async () => {
  t = 0; let n = 0;
  const r = await deliver("hi", { ...base(), ptySend: () => n++, transcriptHas: async () => n >= 2 });
  assert.deepStrictEqual([r.delivered, r.attempts], [true, 2]);
});
test("acked channel that never lands falls back to pty on retry", async () => {
  t = 0; let ch = 0, pty = 0;
  const r = await deliver("hi", { ...base(), channelSend: async () => (ch++ === 0 ? { ok: true } : { ok: false, reason: "gone" }), ptySend: () => pty++, transcriptHas: async () => pty >= 1 });
  assert.deepStrictEqual([r.delivered, r.via, r.attempts], [true, "pty", 2]);
});
test("staleInfo", () => {
  assert.strictEqual(staleInfo({ exists: true, mtimeMs: 100 }, 5000).stale, true);
  assert.strictEqual(staleInfo({ exists: true, mtimeMs: 9000 }, 5000).stale, false);
  assert.strictEqual(staleInfo({ exists: false }, 5000).stale, false);
});
test("agentChannel.resolveAddress picks the live session for the agent folder", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const agent = path.join(d, "Agent X");
  fs.writeFileSync(path.join(d, "1.json"), JSON.stringify({ pid: process.pid, cwd: path.join(agent, ".claude-session"), messagingSocketPath: "PIPE-X", updatedAt: 5 }));
  fs.writeFileSync(path.join(d, "2.json"), JSON.stringify({ pid: 999999999, cwd: agent, messagingSocketPath: "dead", updatedAt: 9 }));
  fs.writeFileSync(path.join(d, "3.key"), "secret");
  assert.strictEqual(channel.resolveAddress(agent, d).socketPath, "PIPE-X");
  assert.strictEqual(channel.resolveAddress(path.join(d, "other"), d), null);
  assert.strictEqual((await channel.send(agent, "t", d)).ok, false); // no transport registered
  channel.setTransport(async (sp, text) => ({ ok: sp === "PIPE-X" && text === "t" }));
  assert.strictEqual((await channel.send(agent, "t", d)).ok, true);
  channel.setTransport(null);
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok   " + n); } catch (e) { fail++; console.log("FAIL " + n + "\n" + e.stack); }
  }
  process.exit(fail ? 1 : 0);
})();

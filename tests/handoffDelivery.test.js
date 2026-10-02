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
  channel.setTransport(null);
  assert.strictEqual((await channel.send(agent, "t", d)).ok, false); // no transport registered
  channel.setTransport(async (sp, text) => ({ ok: sp === "PIPE-X" && text === "t" }));
  assert.strictEqual((await channel.send(agent, "t", d)).ok, true);
  channel.setTransport(null);
});

const MULTI = "hello" + String.fromCharCode(10) + "world";
test("file-drop transport: exact shape, atomic (no partial/tmp left), env override, default dir", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  const dir = path.join(d, "nested", "requests"); // created if missing
  const old = process.env.AGENT_DESKTOP_RELAY_DIR;
  process.env.AGENT_DESKTOP_RELAY_DIR = dir;
  const hb = path.join(d, "nested", "relay-alive");
  fs.mkdirSync(path.dirname(hb), { recursive: true }); fs.writeFileSync(hb, "x"); // fresh heartbeat
  try {
    assert.strictEqual(channel.relayDir(), dir);
    const r = channel.fileDropTransport("PIPE-Z", MULTI, { agent: "SEO Agent" });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.queued, true);
    const files = fs.readdirSync(dir);
    assert.deepStrictEqual(files, [r.id + ".json"]); // renamed into place, no .tmp left
    const j = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
    assert.deepStrictEqual(Object.keys(j).sort(), ["agent", "createdAt", "expiresAt", "id", "text", "to", "ttlSec"]);
    assert.strictEqual(j.ttlSec, 120); assert.strictEqual(Date.parse(j.expiresAt) - Date.parse(j.createdAt), 120000);
    assert.strictEqual(j.id, r.id); assert.strictEqual(j.agent, "SEO Agent");
    assert.strictEqual(j.to, "uds:PIPE-Z"); assert.strictEqual(j.text, MULTI);
    assert.ok(!isNaN(Date.parse(j.createdAt)));
    const r2 = channel.fileDropTransport("PIPE-Z", "again", {});
    assert.notStrictEqual(r2.id, r.id); assert.strictEqual(fs.readdirSync(dir).length, 2);
    // the reader's glob (*.json) must never match an in-progress temp name
    assert.ok(fs.readdirSync(dir).every((f) => f.endsWith(".json") && !f.startsWith(".")));
    // through send(): default transport, agent name = folder basename
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
    const agent = path.join(sd, "Agent Q");
    fs.writeFileSync(path.join(sd, "1.json"), JSON.stringify({ pid: process.pid, cwd: agent, messagingSocketPath: "PIPE-Q", updatedAt: 1 }));
    channel.setTransport(channel.fileDropTransport);
    const s = await channel.send(agent, "via send", sd);
    assert.deepStrictEqual([s.ok, s.queued], [true, true]);
    const got = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))).find((x) => x.text === "via send");
    assert.deepStrictEqual([got.agent, got.to], ["Agent Q", "uds:PIPE-Q"]);
  } finally {
    if (old === undefined) delete process.env.AGENT_DESKTOP_RELAY_DIR; else process.env.AGENT_DESKTOP_RELAY_DIR = old;
    channel.setTransport(channel.fileDropTransport);
  }
  assert.ok(/handoff_relay.requests$/.test(channel.relayDir()));
});

test("relay heartbeat absent or stale: transport unavailable, delivery uses pty on attempt 1", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relayhb-"));
  const old = process.env.AGENT_DESKTOP_RELAY_DIR;
  process.env.AGENT_DESKTOP_RELAY_DIR = path.join(d, "requests");
  try {
    assert.deepStrictEqual(channel.fileDropTransport("P", "x", {}), { ok: false, reason: "no relay" });
    assert.ok(!fs.existsSync(path.join(d, "requests"))); // nothing written
    const hb = path.join(d, "relay-alive"); fs.writeFileSync(hb, "x");
    const old2 = new Date(Date.now() - 90000); fs.utimesSync(hb, old2, old2);
    assert.strictEqual(channel.relayAlive(), false);
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), "sess-")); const agent = path.join(sd, "A");
    fs.writeFileSync(path.join(sd, "1.json"), JSON.stringify({ pid: process.pid, cwd: agent, messagingSocketPath: "PIPE", updatedAt: 1 }));
    channel.setTransport(channel.fileDropTransport);
    assert.deepStrictEqual(await channel.send(agent, "t", sd), { ok: false, reason: "no relay" });
    t = 0; let pty = 0;
    const r = await deliver("hi", { ...base(), channelSend: (x, o) => channel.send(agent, x, sd, o), ptySend: () => pty++, transcriptHas: async () => pty >= 1 });
    assert.deepStrictEqual([r.delivered, r.via, r.attempts, pty], [true, "pty", 1, 1]);
    fs.utimesSync(hb, new Date(), new Date());
    assert.strictEqual(channel.relayAlive(), true);
    assert.strictEqual((await channel.send(agent, "t", sd)).ok, true);
  } finally { if (old === undefined) delete process.env.AGENT_DESKTOP_RELAY_DIR; else process.env.AGENT_DESKTOP_RELAY_DIR = old; }
});
test("acked channel that never lands: channel used once, attempt 2 is pty", async () => {
  t = 0; let ch = 0, pty = 0;
  const r = await deliver("hi", { ...base(), channelSend: async () => { ch++; return { ok: true }; }, ptySend: () => pty++, transcriptHas: async () => pty >= 1 });
  assert.deepStrictEqual([r.delivered, r.via, r.attempts, ch, pty], [true, "pty", 2, 1, 1]);
});
test("never retypes while the first pty prompt is still queued", async () => {
  t = 0; let pty = 0, queued = true;
  const r = await deliver("hi", { ...base(), ptySend: () => pty++, ptyQueued: () => queued, transcriptHas: async () => { if (t > 9000) queued = false; return pty >= 2; } });
  assert.strictEqual(r.delivered, true);
  assert.ok(pty === 2 && r.attempts >= 2);
  t = 0; pty = 0; queued = true;
  await deliver("hi", { ...base(), ptySend: () => pty++, ptyQueued: () => true, transcriptHas: async () => false });
  assert.strictEqual(pty, 1);
});
test("abort stops sending and typing", async () => {
  t = 0; let pty = 0, ab = false;
  const r = await deliver("hi", { ...base(), ptySend: () => { pty++; ab = true; }, aborted: () => ab, transcriptHas: async () => false });
  assert.deepStrictEqual([r.delivered, r.aborted, pty], [false, true, 1]);
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok   " + n); } catch (e) { fail++; console.log("FAIL " + n + "\n" + e.stack); }
  }
  process.exit(fail ? 1 : 0);
})();

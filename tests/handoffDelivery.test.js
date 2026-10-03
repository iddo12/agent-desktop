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
  assert.deepStrictEqual([r.delivered, r.attempts, pty], [false, 3, 1]);
  assert.strictEqual(lines.filter((l) => /NOT in transcript/.test(l)).length, 3);
  assert.ok(t >= 8000 + 20000 + 45000);
});
test("lands on second attempt", async () => {
  t = 0; let n = 0;
  const r = await deliver("hi", { ...base(), ptySend: () => n++, transcriptHas: async () => t > 9000 }); // lands late (CLI queued it); never retyped
  assert.deepStrictEqual([r.delivered, r.attempts, n], [true, 2, 1]);
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
  // v1.63.8: default is under HOME (not AppData/userData, which MSIX virtualizes for the relay)
  assert.strictEqual(channel.relayDir(), path.join(os.homedir(), ".agent-desktop-relay", "requests"));
  assert.strictEqual(channel.heartbeatPath(), path.join(os.homedir(), ".agent-desktop-relay", "relay-alive"));
});

test("test mode never shares the live relay dir", () => {
  const oldE = process.env.AGENT_DESKTOP_RELAY_DIR, oldT = process.env.AGENT_DESKTOP_TEST_MODE;
  delete process.env.AGENT_DESKTOP_RELAY_DIR; process.env.AGENT_DESKTOP_TEST_MODE = "1";
  try {
    const d = channel.relayDir();
    assert.ok(/handoff_relay.requests$/.test(d));
    assert.ok(!d.startsWith(path.join(os.homedir(), ".agent-desktop-relay")));
  } finally {
    if (oldE !== undefined) process.env.AGENT_DESKTOP_RELAY_DIR = oldE;
    if (oldT === undefined) delete process.env.AGENT_DESKTOP_TEST_MODE; else process.env.AGENT_DESKTOP_TEST_MODE = oldT;
  }
});

test("cancel removes a still-queued request file; deliver withdraws it on pty fallback", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relaycx-"));
  const old = process.env.AGENT_DESKTOP_RELAY_DIR;
  process.env.AGENT_DESKTOP_RELAY_DIR = path.join(d, "requests");
  try {
    fs.writeFileSync(path.join(d, "relay-alive"), "x");
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), "sess-")); const agent = path.join(sd, "A");
    fs.writeFileSync(path.join(sd, "1.json"), JSON.stringify({ pid: process.pid, cwd: agent, messagingSocketPath: "PIPE", updatedAt: 1 }));
    channel.setTransport(channel.fileDropTransport);
    const s = await channel.send(agent, "t", sd);
    assert.ok(s.ok && s.id);
    assert.deepStrictEqual(channel.cancel(s.id), { ok: true, removed: true });
    assert.deepStrictEqual(channel.cancel(s.id), { ok: true, removed: false });
    assert.strictEqual(channel.cancel("../evil").removed, false);
    t = 0; let pty = 0, left = null;
    const r = await deliver("hi", { ...base(), channelSend: (x, o) => channel.send(agent, x, sd, o),
      channelCancel: (id) => channel.cancel(id), ptySend: () => { pty++; left = fs.readdirSync(path.join(d, "requests")).filter((f) => f.endsWith(".json")); }, transcriptHas: async () => pty >= 1 });
    assert.deepStrictEqual([r.delivered, r.via, pty, left.length], [true, "pty", 1, 0]);
  } finally {
    if (old === undefined) delete process.env.AGENT_DESKTOP_RELAY_DIR; else process.env.AGENT_DESKTOP_RELAY_DIR = old;
  }
});

test("purgeQueue removes only matching queued prompts", () => {
  const { purgeQueue } = require("../src/handoffDelivery");
  const q = ["[hid:1] save it", "other", "[hid:2] save it", "keep"];
  assert.strictEqual(purgeQueue(q, "save it"), 2);
  assert.deepStrictEqual(q, ["other", "keep"]);
  assert.strictEqual(purgeQueue(null, "x"), 0);
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
  const r = await deliver("hi", { ...base(), ptySend: () => pty++, ptyQueued: () => queued, transcriptHas: async () => { if (t > 9000) queued = false; return t > 20000; } });
  assert.strictEqual(pty, 1);          // v1.67.1: typed once, then only waited for (was: typed again once the queue drained)
  assert.strictEqual(r.delivered, true);
  t = 0; pty = 0; queued = true;
  await deliver("hi", { ...base(), ptySend: () => pty++, ptyQueued: () => true, transcriptHas: async () => false });
  assert.strictEqual(pty, 1);
});
test("dead pty: the prompt is typed exactly once across all retries, then gives up (no duplicates)", async () => {
  t = 0; let pty = 0;
  const r = await deliver("hi", { ...base(), ptySend: () => pty++, transcriptHas: async () => false });
  assert.strictEqual(pty, 1);
  assert.strictEqual(r.delivered, false);
});
test("duplicate delivery with the same hid marker: second call never types", async () => {
  t = 0; let pty = 0;
  const opts = { marker: "[hid:dup1]" };
  await deliver("hi", { ...base(), ptySend: () => pty++, transcriptHas: async () => true }, opts);
  await deliver("hi", { ...base(), ptySend: () => pty++, transcriptHas: async () => false }, opts);
  assert.strictEqual(pty, 1);
});
test("queued mid-turn: a receipt in the transcript (queued_command / enqueue) counts as landed, no retype", async () => {
  t = 0; let pty = 0;
  // transcriptHas is a raw substring search over the transcript tail, so a queue-operation enqueue entry or a
  // queued_command attachment carrying the marker is found just like a user entry
  const transcript = JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "[hid:q1] Write handoff" } });
  const r = await deliver("Write handoff", { ...base(), ptySend: () => pty++, transcriptHas: async (m) => transcript.includes(m) }, { marker: "[hid:q1]" });
  assert.deepStrictEqual([r.delivered, r.attempts, pty], [true, 1, 1]);
});
test("abort stops sending and typing", async () => {
  t = 0; let pty = 0, ab = false;
  const r = await deliver("hi", { ...base(), ptySend: () => { pty++; ab = true; }, aborted: () => ab, transcriptHas: async () => false });
  assert.deepStrictEqual([r.delivered, r.aborted, pty], [false, true, 1]);
});

test("typed prompt that sits unsent: the delivery presses Enter (nudgeSubmit) and it lands, still typed once", async () => {
  t = 0; let pty = 0, presses = 0, sent = false;
  const r = await deliver("hi", { ...base(), ptySend: () => pty++, nudgeSubmit: async () => { presses++; sent = true; return true; }, transcriptHas: async () => sent });
  assert.deepStrictEqual([r.delivered, pty], [true, 1]);
  assert.ok(presses >= 1);
});
test("nudgeSubmit is not used before the prompt was typed (channel path)", async () => {
  t = 0; let presses = 0;
  await deliver("hi", { ...base(), channelSend: async () => ({ ok: true }), ptySend: () => {}, nudgeSubmit: async () => { presses++; return false; }, transcriptHas: async () => true });
  assert.strictEqual(presses, 0);
});

test("keep-going style nudge: typed once, left unsent in the box, Enter pressed by nudgeSubmit with the body, then lands", async () => {
  t = 0; let pty = 0, sent = false; const bodies = [];
  const r = await deliver("keep going", { ...base(), ptySend: () => pty++, nudgeSubmit: async (b) => { bodies.push(b); sent = true; return true; }, transcriptHas: async () => sent }, { marker: "[hid:kg1]" });
  assert.deepStrictEqual([r.delivered, pty], [true, 1]);
  assert.ok(bodies.length >= 1 && bodies[0] === "[hid:kg1] keep going", "nudgeSubmit gets the typed body");
});
test("a ptySend that refuses (user draft) never types and is never retried with the same marker", async () => {
  t = 0; let tries = 0;
  const r = await deliver("keep going", { ...base(), ptySend: () => { tries++; throw new Error("draft"); }, transcriptHas: async () => false }, { marker: "[hid:kg2]" });
  assert.strictEqual(r.delivered, false);
  assert.strictEqual(tries, 1);
});

test("a refused pty send (flagged refused) typed nothing: later attempts may still type it once, never twice", async () => {
  t = 0; let tries = 0, typed = 0;
  const r = await deliver("keep going", { ...base(), ptySend: () => { tries++; if (tries < 3) { const e = new Error("draft"); e.refused = true; throw e; } typed++; }, transcriptHas: async () => typed > 0 }, { marker: "[hid:kg3]" });
  assert.deepStrictEqual([r.delivered, typed, tries], [true, 1, 3]);
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok   " + n); } catch (e) { fail++; console.log("FAIL " + n + "\n" + e.stack); }
  }
  process.exit(fail ? 1 : 0);
})();

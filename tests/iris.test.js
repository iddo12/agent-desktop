// IRIS tests - run with:  node --test tests/iris.test.js
// Two IrisService instances on loopback, each with its own temp folder,
// exercising pairing, delivery and every rejection path the design promises.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { IrisService, exchange } = require("../src/iris/service");
const ic = require("../src/iris/crypto");
const gw = require("../src/iris/gateway");

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `iris-${tag}-`));
}

async function makePair(portA, portB) {
  const gotA = [], gotB = [];
  const A = new IrisService({ dir: tmpDir("a"), name: "Iddo PC", port: portA, bindHost: "127.0.0.1", deliver: (p, e, f) => gotA.push({ p, e, f }) });
  const B = new IrisService({ dir: tmpDir("b"), name: "Merav PC", port: portB, bindHost: "127.0.0.1", deliver: (p, e, f) => gotB.push({ p, e, f }) });
  await A.setEnabled(true);
  await B.setEnabled(true);
  return { A, B, gotA, gotB };
}

test("crypto: seal/open round trip, tamper and wrong-peer fail", () => {
  const a = ic.generateIdentity("a"), b = ic.generateIdentity("b"), c = ic.generateIdentity("c");
  const f = ic.seal({ hello: 1 }, a, ic.publicPart(b));
  const ok = ic.open(f, b, (id) => (id === a.id ? ic.publicPart(a) : null));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, { hello: 1 });
  const t = Object.assign({}, f, { c: Buffer.from(Buffer.from(f.c, "base64").map((x, i) => (i === 40 ? x ^ 1 : x))).toString("base64") });
  assert.equal(ic.open(t, b, (id) => (id === a.id ? ic.publicPart(a) : null)).reason, "decrypt-failed");
  // c claims to be a: box from c's key doesn't open with a's public key
  const forged = ic.seal({ hello: 2 }, c, ic.publicPart(b));
  forged.from = a.id;
  assert.equal(ic.open(forged, b, (id) => (id === a.id ? ic.publicPart(a) : null)).ok, false);
  assert.equal(ic.open(f, c, () => ic.publicPart(a)).reason, "not-for-us");
  assert.equal(ic.fingerprint(a, b), ic.fingerprint(b, a));
});

test("gateway: secret filter catches credentials, passes normal text", () => {
  assert.equal(gw.findSecret("the shoot is on Tuesday at 10"), null);
  assert.ok(gw.findSecret("key sk-ant-api03-abcdefghijklmnopqrstuv"));
  assert.ok(gw.findSecret("password: hunter22x"));
  assert.ok(gw.findSecret("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.ok(gw.findSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
});

test("pair, exchange messages both ways, and every rejection path", async () => {
  const { A, B, gotA, gotB } = await makePair(47391, 47392);
  let C = null;
  try {
    // --- pairing with a wrong code fails, the invite survives until tries run out
    const inv = A.createInvite();
    assert.equal(inv.ok, true);
    const wrong = inv.strings[0].replace(/:[^:]+$/, ":AAAA-BBBB-CCCC-DDDD");
    assert.equal((await B.join(wrong)).reason, "bad-proof");
    const joined = await B.join(inv.strings[0]);
    assert.equal(joined.ok, true, JSON.stringify(joined));
    assert.equal(Object.keys(A.peers).length, 1);
    assert.equal(A.status().peers[0].fingerprint, joined.fingerprint);
    // invite is single use
    C = new IrisService({ dir: tmpDir("c"), name: "Stranger", port: 47393, bindHost: "127.0.0.1" });
    await C.setEnabled(true);
    assert.equal((await C.join(inv.strings[0])).reason, "no-open-invite");

    // --- B -> A info message arrives, framed as untrusted
    const s1 = B.send({ peerId: A.me.id, text: "Shoot moved to Thursday 10:00" });
    assert.equal(s1.ok, true);
    await B.flushOutbox();
    assert.equal(gotA.length, 1);
    assert.match(gotA[0].f, /not an instruction/);
    assert.match(gotA[0].f, /Shoot moved to Thursday/);
    assert.equal(B.outbox.find((o) => o.env.id === s1.id).status, "delivered");

    // --- request is flagged Stage 1 (no action)
    B.send({ peerId: "Iddo PC", text: "Please export the proxy", type: "request" });
    await B.flushOutbox();
    assert.match(gotA[1].f, /do NOT carry out this request/);

    // --- A -> B reply
    const r = A.send({ peerId: B.me.id, text: "Noted, thanks", type: "reply", replyTo: s1.id });
    assert.equal(r.ok, true);
    await A.flushOutbox();
    assert.equal(gotB.length, 1);
    assert.match(gotB[0].f, /reply to/);

    // --- outbound secret blocked, never queued
    const leak = A.send({ peerId: B.me.id, text: "the api_key=abcdef123456" });
    assert.equal(leak.ok, false);
    assert.match(leak.reason, /blocked-secret/);

    // --- replay: resend the exact same frame
    const env = { id: "replaytest01", type: "info", text: "hi", hop: 0, sent: new Date().toISOString(), expires: new Date(Date.now() + 60000).toISOString() };
    const frame = ic.seal({ kind: "msg", port: 47392, env }, B.me, ic.publicPart(A.me));
    const ack1 = ic.open(await exchange("127.0.0.1", 47391, frame), B.me, () => ic.publicPart(A.me));
    assert.equal(ack1.payload.ok, true);
    const ack2 = ic.open(await exchange("127.0.0.1", 47391, frame), B.me, () => ic.publicPart(A.me));
    assert.equal(ack2.payload.ok, false);
    assert.equal(ack2.payload.reason, "replay");

    // --- expired, hop limit, extra fields
    for (const [bad, reason] of [
      [{ ...env, id: "expired00001", expires: new Date(Date.now() - 1000).toISOString() }, "expired"],
      [{ ...env, id: "hoplimit0001", hop: 3 }, "hop-limit"],
      [{ ...env, id: "extrafield01", run: "rm -rf" }, "unknown-field:run"],
      [{ ...env, id: "attach000001", attachments: [] }, "attachments-not-allowed"],
    ]) {
      const fr = ic.seal({ kind: "msg", port: 47392, env: bad }, B.me, ic.publicPart(A.me));
      const ack = ic.open(await exchange("127.0.0.1", 47391, fr), B.me, () => ic.publicPart(A.me));
      assert.equal(ack.payload.reason, reason);
    }

    // --- stranger (C, unpaired) gets no reply at all
    const strangerFrame = ic.seal({ kind: "msg", port: 47393, env: { ...env, id: "stranger0001" } }, C.me, ic.publicPart(A.me));
    await assert.rejects(exchange("127.0.0.1", 47391, strangerFrame));

    // --- garbage line gets dropped
    await assert.rejects(new Promise((res, rej) => {
      const s = net.createConnection({ host: "127.0.0.1", port: 47391 }, () => s.write("not json\n"));
      s.on("data", res); s.on("close", () => rej(new Error("closed"))); s.on("error", rej);
    }));

    // --- pause: A pauses B -> rejected
    A.setPeer(B.me.id, { paused: true });
    const fr = ic.seal({ kind: "msg", port: 47392, env: { ...env, id: "paused000001" } }, B.me, ic.publicPart(A.me));
    assert.equal(ic.open(await exchange("127.0.0.1", 47391, fr), B.me, () => ic.publicPart(A.me)).payload.reason, "peer-paused");
    A.setPeer(B.me.id, { paused: false });

    // --- global off: listener closes
    await A.setEnabled(false);
    await assert.rejects(exchange("127.0.0.1", 47391, fr));
    await A.setEnabled(true);

    // --- daily cap
    A.setPeer(B.me.id, { dailyCap: 0 });
    const capFr = ic.seal({ kind: "msg", port: 47392, env: { ...env, id: "capped000001" } }, B.me, ic.publicPart(A.me));
    assert.equal(ic.open(await exchange("127.0.0.1", 47391, capFr), B.me, () => ic.publicPart(A.me)).payload.reason, "daily-cap");

    // --- keys persist across restart; secret keys go through protect()
    const idFile = JSON.parse(fs.readFileSync(path.join(A.dir, "identity.json"), "utf8"));
    assert.ok(idFile.secret && !JSON.stringify(idFile.public).includes("Sk"));
    const A2 = new IrisService({ dir: A.dir, port: 47394, bindHost: "127.0.0.1" });
    assert.equal(A2.me.id, A.me.id);

    // --- unpair: B's messages no longer accepted
    A.unpair(B.me.id);
    const upFr = ic.seal({ kind: "msg", port: 47392, env: { ...env, id: "unpaired0001" } }, B.me, ic.publicPart(A.me));
    await assert.rejects(exchange("127.0.0.1", 47391, upFr));

    // --- audit log recorded the story
    const events = A.readLog(500).map((e) => e.event);
    for (const ev of ["paired", "received", "rejected", "frame-dropped", "send-blocked", "unpaired"]) assert.ok(events.includes(ev), ev);
  } finally {
    if (C) await C.stop();
    await A.stop();
    await B.stop();
  }
});

test("offline peer: message waits in outbox, delivered when peer returns", async () => {
  const { A, B, gotA } = await makePair(47395, 47396);
  try {
    const inv = A.createInvite();
    assert.equal((await B.join(inv.strings[0])).ok, true);
    await A.setEnabled(false);
    const s = B.send({ peerId: A.me.id, text: "are you there?" });
    await B.flushOutbox();
    assert.equal(B.outbox.find((o) => o.env.id === s.id).status, "pending");
    await A.setEnabled(true);
    await B.flushOutbox();
    assert.equal(B.outbox.find((o) => o.env.id === s.id).status, "delivered");
    assert.equal(gotA.length, 1);
  } finally {
    await A.stop();
    await B.stop();
  }
});

// node tests/gmail.test.js - My Daily Gmail connector (src/daily/gmail.js) with a fake Google (no network, no real tokens)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { create, classifyThread } = require("../src/daily/gmail");

let fails = 0, n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gmail-"));
const fakeStore = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("ENC:" + s), decryptString: (b) => { const s = b.toString(); if (!s.startsWith("ENC:")) throw new Error("bad"); return s.slice(4); } };
const msg = (o) => ({ id: o.id || "m1", internalDate: String(NOW - (o.days || 2) * DAY), labelIds: o.labels || ["INBOX"], payload: { headers: [
  { name: "From", value: o.from || "Bob <bob@x.com>" }, { name: "To", value: o.to || "me@gmail.com" }, { name: "Subject", value: o.subject || "Hello" }, { name: "Message-ID", value: o.mid || "<M1@x>" }] } });

t("classifyThread: reply needed / sent without reply / noise ignored", () => {
  const a = classifyThread({ messages: [msg({ days: 3 })] }, "me@gmail.com", NOW);
  assert.deepStrictEqual([a.kind, a.id, a.ageDays, a.from], ["needAnswer", "m1@x", 3, "Bob <bob@x.com>"]);
  const b = classifyThread({ messages: [msg({ from: "Me <me@gmail.com>", to: "Dan <dan@x.com>", labels: ["SENT"], days: 5, mid: "<S1@g>" })] }, "me@gmail.com", NOW);
  assert.deepStrictEqual([b.kind, b.to, b.ageDays], ["sentNoReply", "Dan <dan@x.com>", 5]);
  // I answered last -> counts as sent, not as needing an answer
  const c = classifyThread({ messages: [msg({ days: 4 }), msg({ id: "m2", from: "me@gmail.com", labels: ["SENT"], days: 3, mid: "<S2@g>" })] }, "me@gmail.com", NOW);
  assert.strictEqual(c.kind, "sentNoReply");
  assert.strictEqual(classifyThread({ messages: [msg({ from: "Shop <no-reply@shop.com>" })] }, "me@gmail.com", NOW).kind, null);
  assert.strictEqual(classifyThread({ messages: [msg({ labels: ["INBOX", "CATEGORY_PROMOTIONS"] })] }, "me@gmail.com", NOW).kind, null);
  assert.strictEqual(classifyThread({ messages: [] }, "me@gmail.com", NOW).kind, null);
  // bulk mail (List-Unsubscribe / Precedence: bulk) never needs an answer
  const bulk = msg({ days: 1 }); bulk.payload.headers.push({ name: "List-Unsubscribe", value: "<mailto:x@y>" });
  assert.strictEqual(classifyThread({ messages: [bulk] }, "me@gmail.com", NOW).kind, null);
  const prec = msg({ days: 1 }); prec.payload.headers.push({ name: "Precedence", value: "bulk" });
  assert.strictEqual(classifyThread({ messages: [prec] }, "me@gmail.com", NOW).kind, null);
  const u = classifyThread({ messages: [msg({ days: 0, labels: ["INBOX", "UNREAD", "IMPORTANT"] })] }, "me@gmail.com", NOW);
  assert.deepStrictEqual([u.unread, u.important, u.kind], [true, true, "needAnswer"]);
});

function fakeGoogle(opts) {
  const log = [];
  const request = async (method, url, o) => {
    log.push(method + " " + url.split("?")[0]);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const p = new URLSearchParams(o.body);
      if (p.get("grant_type") === "authorization_code") { assert.ok(p.get("code_verifier") && p.get("redirect_uri").startsWith("http://127.0.0.1:")); return { status: 200, json: { access_token: "AT1", refresh_token: "RT1" } }; }
      if (opts && opts.revoked) return { status: 400, json: { error: "invalid_grant" } };
      return { status: 200, json: { access_token: "AT2" } };
    }
    assert.ok(o.headers.Authorization.startsWith("Bearer "));
    if (url.endsWith("/profile")) return { status: 200, json: { emailAddress: "Merav@Gmail.com" } };
    if (url.includes("/threads?")) return { status: 200, json: { threads: url.includes("in%3Ainbox") ? [{ id: "a1" }, { id: "a2" }] : [{ id: "b1" }] } };
    const id = /threads\/([0-9a-z]+)/.exec(url)[1];
    const th = { a1: { messages: [msg({ id: "x", days: 6, mid: "<A1@x>", subject: "Quote?" })] }, a2: { messages: [msg({ from: "News <newsletter@x.com>", mid: "<A2@x>" })] },
      b1: { messages: [msg({ from: "me@gmail.com", to: "Lea <lea@x.com>", labels: ["SENT"], days: 8, mid: "<B1@g>", subject: "Invoice" })] } }[id];
    return { status: 200, json: th };
  };
  return { request, log };
}

t("addAccount: PKCE loopback flow stores an encrypted token, never the plain text", async () => {
  const dir = tmp();
  const g = fakeGoogle();
  const g3 = create({
    dataDir: dir, safeStorage: fakeStore, client: { clientId: "cid", clientSecret: "csec" }, request: g.request,
    openExternal: (url) => {
      const u = new URL(url);
      setTimeout(() => http.get(`${u.searchParams.get("redirect_uri")}?code=evil&state=wrong`, (r2) => r2.resume()).on("error", () => {}), 10);   // ignored
      setTimeout(() => http.get(`${u.searchParams.get("redirect_uri")}?code=GOODCODE&state=${u.searchParams.get("state")}`, (r2) => r2.resume()).on("error", () => {}), 60);
    },
  });
  const ok = await g3.addAccount();
  assert.deepStrictEqual(ok, { ok: true, email: "merav@gmail.com" });
  const raw = fs.readFileSync(path.join(dir, "gmail-accounts.bin"));
  assert.ok(!raw.toString().includes("RT1") || raw.toString().startsWith("ENC:"));   // stored through safeStorage
  assert.deepStrictEqual(g3.list().map((a) => a.email), ["merav@gmail.com"]);
});

t("load: reads inbox + sent threads, caches, de-noises; revoked token is reported", async () => {
  const dir = tmp(); const g = fakeGoogle();
  const mk = (gg) => create({ dataDir: dir, safeStorage: fakeStore, client: { clientId: "c", clientSecret: "s" }, request: gg.request, openExternal: () => {} });
  fs.writeFileSync(path.join(dir, "gmail-accounts.bin"), fakeStore.encryptString(JSON.stringify({ accounts: [{ email: "me@gmail.com", refresh: "RT", added: 1 }] })));
  const c = mk(g);
  const r = await c.load(NOW);
  assert.strictEqual(r.connected, true);
  assert.deepStrictEqual(r.emails.needAnswer.map((x) => [x.id, x.subject, x.ageDays, x.account]), [["a1@x", "Quote?", 6, "me@gmail.com"]]);
  assert.deepStrictEqual(r.emails.sentNoReply.map((x) => [x.id, x.to, x.ageDays]), [["b1@g", "Lea <lea@x.com>", 8]]);
  const calls = g.log.length;
  await c.load(NOW);
  assert.strictEqual(g.log.length, calls, "second load within 5 min must use the cache");
  const bad = mk(fakeGoogle({ revoked: true }));
  const r2 = await bad.load(NOW);
  assert.strictEqual(r2.connected, false);
  assert.ok(/expired or was revoked/.test(bad.list()[0].error));
});

t("not configured or no accounts -> not connected, add refused politely; remove works", async () => {
  const dir = tmp();
  const c = create({ dataDir: dir, safeStorage: fakeStore, client: null, request: async () => { throw new Error("no"); }, openExternal: () => {} });
  assert.strictEqual((await c.load(NOW)).connected, false);
  assert.strictEqual((await c.addAccount()).ok, false);
  const noEnc = create({ dataDir: dir, safeStorage: { isEncryptionAvailable: () => false }, client: { clientId: "c", clientSecret: "s" }, request: async () => ({}), openExternal: () => {} });
  assert.strictEqual(noEnc.list().length, 0);
  assert.strictEqual(c.remove("x@y.com").ok, false);
});

(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e && e.stack || e)); } }
  console.log(fails ? `${fails} of ${n} FAILED` : `gmail: ${n} tests passed`);
  process.exit(fails ? 1 : 0);
})();

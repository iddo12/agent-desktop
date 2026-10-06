// node tests/shipments-track.test.js - Shipments providers, key storage, polling rules and the IPC shape. No network, no Electron.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../src/daily/shipments-track");
const M = require("../src/daily/shipments-model");
const S = require("../src/daily/shipments-main");
const D = require("../src/daily/main-daily");
const DAY = 86400000, HOUR = 3600000;
const NOW = Date.parse("2026-10-06T10:00:00Z");
const SECRET = "SECRETKEY-1234567890-abcdef";
let fails = 0, n = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

// Stand-in for Electron safeStorage: reversible, but the stored bytes do not contain the plaintext.
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString("utf8") };
const noSafe = { isEncryptionAvailable: () => false };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ship-"));
const noSleep = () => Promise.resolve();

function fake17(handler) {
  const calls = [];
  const request = async (method, url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ method, url, headers: opts.headers, body });
    const ep = url.split("/").pop();
    return handler(ep, body, opts);
  };
  return { request, calls };
}
const okAll = (ep, body) => ({ status: 200, json: { code: 0, data: { accepted: body.map((b) => Object.assign({ number: b.number, carrier: 9061 }, ep === "gettrackinfo" ? { track_info: { latest_status: { status: "InTransit", sub_status: "InTransit_CustomsProcessing" }, latest_event: { time_iso: "2026-10-06T08:00:00Z", description: "Customs processing", location: "Tel Aviv" }, tracking: { providers: [{ events: [{ time_iso: "2026-10-06T08:00:00Z", description: "Customs processing", location: "Tel Aviv" }, { time_iso: "2026-10-04T08:00:00Z", description: "Departed", location: "Hong Kong" }] }] }, time_metrics: { estimated_delivery_date: { from: "2026-10-10T00:00:00Z", to: "2026-10-12T00:00:00Z" } } } } : {})), rejected: [] } } });

t("key store: encrypted on disk, never plaintext, never echoed", () => {
  const dir = tmp();
  const ks = T.createKeyStore({ dataDir: dir, safeStorage: fakeSafe });
  ks.set("17track", SECRET);
  assert.strictEqual(ks.get("17track"), SECRET);
  assert.strictEqual(ks.has("17track"), true);
  const raw = fs.readFileSync(path.join(dir, "shipments-keys.bin"));
  assert.ok(!raw.toString("utf8").includes(SECRET) && !raw.toString("latin1").includes("SECRETKEY"));
  ks.clear("17track");
  assert.strictEqual(ks.has("17track"), false);
});
t("key store: refuses to store without encryption, rejects junk keys", () => {
  const dir = tmp();
  assert.throws(() => T.createKeyStore({ dataDir: dir, safeStorage: noSafe }).set("17track", SECRET), /cannot encrypt/);
  const ks = T.createKeyStore({ dataDir: dir, safeStorage: fakeSafe });
  for (const bad of ["", "short", "has space inside key 1234", "x".repeat(300), null]) assert.throws(() => ks.set("17track", bad), /does not look like/);
  assert.ok(!fs.existsSync(path.join(dir, "shipments-keys.bin")));
});
t("17TRACK: register then gettrackinfo, key only in a header, parsed events/state/eta", async () => {
  const { request, calls } = fake17(okAll);
  const dir = tmp();
  const tr = T.createTracker({ dataDir: dir, safeStorage: fakeSafe, request, sleep: noSleep });
  tr.keys.set("17track", SECRET);
  const list = [M.makeShipment({ numbers: ["RR123456789IL"], state: "shipped", stateAt: NOW - 5 * DAY }, NOW)];
  const res = await tr.refresh(list, NOW, {});
  assert.deepStrictEqual(calls.map((c) => c.url.split("/").pop()), ["register", "gettrackinfo"]);
  for (const c of calls) { assert.strictEqual(c.headers["17token"], SECRET); assert.ok(!c.url.includes(SECRET) && !JSON.stringify(c.body).includes(SECRET)); assert.ok(c.url.startsWith("https://api.17track.net/")); }
  assert.strictEqual(calls[0].body[0].carrier, 9061);
  assert.strictEqual(res.polled, 1); assert.strictEqual(res.changed.length, 1);
  assert.strictEqual(list[0].state, "customs");
  assert.strictEqual(list[0].lastEvent.place, "Tel Aviv");
  assert.strictEqual(list[0].eta.slice(0, 10), "2026-10-12");
  assert.strictEqual(list[0].events.length, 2);
});
t("17TRACK: batches of at most 40 numbers per call", async () => {
  const { request, calls } = fake17(okAll);
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, request, sleep: noSleep });
  tr.keys.set("17track", SECRET);
  const list = [];
  for (let i = 0; i < 85; i++) list.push(M.makeShipment({ numbers: ["RR" + String(100000000 + i) + "IL"], state: "shipped", stateAt: NOW }, NOW));
  await tr.refresh(list, NOW, {});
  const sizes = calls.filter((c) => c.url.endsWith("gettrackinfo")).map((c) => c.body.length);
  assert.deepStrictEqual(sizes, [40, 40, 5]);
  assert.ok(calls.every((c) => c.body.length <= 40));
});
t("17TRACK: already-registered is fine, real rejection and rate limit surface as errors, no key = no calls", async () => {
  let n429 = 0;
  const { request } = fake17((ep, body) => {
    if (ep === "register") return { status: 200, json: { code: 0, data: { accepted: [], rejected: body.map((b) => ({ number: b.number, error: { code: -18019901, message: "The tracking number has been registered." } })) } } };
    n429++; return { status: 429, json: null };
  });
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, request, sleep: noSleep });
  const list = [M.makeShipment({ numbers: ["RR123456789IL"], state: "shipped", stateAt: NOW }, NOW)];
  assert.strictEqual((await tr.refresh(list, NOW, {})).polled, 0);   // no key: nothing polled
  assert.strictEqual(n429, 0);
  tr.keys.set("17track", SECRET);
  const res = await tr.refresh(list, NOW, {});
  assert.ok(/rate/.test(res.errors["RR123456789IL"]), JSON.stringify(res.errors));
  assert.strictEqual(list[0].polledOk, false);
});
t("no key: manual provider only, nothing archived/delivered or Amazon is polled", async () => {
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, sleep: noSleep });
  assert.strictEqual(tr.hasLiveProvider(), false);
  const list = [M.makeShipment({ numbers: ["RR123456789IL"] }, NOW)];
  assert.strictEqual(tr.due(list, NOW, false).length, 0);
  tr.keys.set("17track", SECRET);
  const live = [M.makeShipment({ numbers: ["RR123456789IL", "TBA123456789012"] }, NOW), M.makeShipment({ numbers: ["RR123456780IL"], archived: true }, NOW), M.makeShipment({ numbers: ["RR123456781IL"], state: "delivered" }, NOW)];
  assert.deepStrictEqual(tr.due(live, NOW, false).map((d) => d.number), ["RR123456789IL"]);
});
t("DHL parcels are polled at most every 6 h (force overrides)", async () => {
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, sleep: noSleep });
  tr.keys.set("17track", SECRET); tr.keys.set("dhl", "DHLKEY-1234567890");
  const s = M.makeShipment({ numbers: [{ no: "1234567890", carrier: "dhl" }], carrier: "dhl", polledAt: NOW - 2 * HOUR }, NOW);
  assert.strictEqual(tr.due([s], NOW, false).length, 0);
  s.polledAt = NOW - 7 * HOUR;
  assert.strictEqual(tr.due([s], NOW, false)[0].provider.id, "dhl");
  s.polledAt = NOW - HOUR;
  assert.strictEqual(tr.due([s], NOW, true).length, 1);
  const noDhlKey = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, sleep: noSleep });
  noDhlKey.keys.set("17track", SECRET);
  assert.strictEqual(noDhlKey.due([s], NOW, true)[0].provider.id, "17track");   // falls back to 17TRACK, not the stub
});
t("DHL client parses a response and sends the key only as a header", async () => {
  const seen = [];
  const request = async (m, url, o) => { seen.push({ url, h: o.headers }); return { status: 200, json: { shipments: [{ status: { statusCode: "delivered" }, events: [{ timestamp: "2026-10-05T10:00:00Z", description: "Delivered", location: { address: { addressLocality: "Haifa" } } }] }] } }; };
  const p = T.createDhl({ getKey: () => "DHLKEY-1234567890", request, sleep: noSleep });
  const r = await p.track([{ number: "1234567890", carrier: "dhl" }]);
  assert.strictEqual(r.results["1234567890"].state, "delivered");
  assert.strictEqual(r.results["1234567890"].events[0].place, "Haifa");
  assert.ok(!seen[0].url.includes("DHLKEY") && seen[0].h["DHL-API-Key"] === "DHLKEY-1234567890");
});
t("UPS and FedEx stubs are wired but disabled; fake provider records calls", async () => {
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe });
  assert.strictEqual(tr.providers.ups.enabled(), false); assert.strictEqual(tr.providers.fedex.enabled(), false);
  assert.strictEqual(tr.providers.manual.enabled(), true);
  const fk = T.createFake({ RR123456789IL: { events: [{ at: NOW, text: "Delivered" }], state: "delivered" } });
  const tr2 = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, fakeProvider: fk });
  const list = [M.makeShipment({ numbers: ["RR123456789IL"], state: "in_transit", stateAt: NOW - DAY }, NOW)];
  await tr2.refresh(list, NOW, {});
  assert.strictEqual(list[0].state, "delivered"); assert.strictEqual(list[0].archived, true);
  assert.deepStrictEqual(fk.calls, [["RR123456789IL"]]);
});
t("network layer only talks https to allow-listed hosts", async () => {
  await assert.rejects(T.httpRequest("GET", "http://api.17track.net/x"), /host not allowed/);
  await assert.rejects(T.httpRequest("GET", "https://evil.example.com/x"), /host not allowed/);
});

// ---------------------------------------------------------------- service + IPC shape
const WIN = { webContents: { id: 1, mainFrame: { id: "main" } } };
const OWN = { sender: WIN.webContents, senderFrame: WIN.webContents.mainFrame };
function boot(extra) {
  const h = {};
  const root = tmp();
  const dataDir = path.join(root, "appdata");
  D.init(Object.assign({ ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => WIN, root, dataDir, safeStorage: fakeSafe, testMode: false, log: () => {}, runPython: async () => "ok" }, extra || {}));
  return { h, root, dataDir };
}
t("IPC: shipments channels exist and refuse foreign callers", async () => {
  const b = boot();
  for (const c of ["daily-shipments-load", "daily-shipments-refresh", "daily-shipments-op", "daily-shipments-key"]) {
    assert.ok(b.h[c], c + " missing");
    for (const ev of [null, {}, { sender: { id: 2 } }, { sender: WIN.webContents, senderFrame: { id: "iframe" } }]) {
      const r = await b.h[c](ev, {});
      assert.ok(r && r.ok === false && r.reason === "Not allowed.", c + " accepted a foreign caller");
    }
  }
});
t("IPC: load shape, add/archive/picked-up/bring-back/delete round trip, junk input", async () => {
  const b = boot();
  let v = await b.h["daily-shipments-load"](OWN, {});
  assert.strictEqual(v.ok, true);
  for (const k of ["items", "counts", "provider", "states", "stuckDays", "now"]) assert.ok(k in v, k);
  assert.strictEqual(v.provider.live, false);
  assert.strictEqual(v.items.length, 0);
  const bad = await b.h["daily-shipments-op"](OWN, { op: "add", text: "hello world" });
  assert.strictEqual(bad.ok, false);
  const add = await b.h["daily-shipments-op"](OWN, { op: "add", text: "RR123456789IL from Dana" });
  assert.strictEqual(add.ok, true);
  v = await b.h["daily-shipments-load"](OWN, {});
  assert.strictEqual(v.items.length, 1);
  const it = v.items[0];
  assert.strictEqual(it.carrier, "israelpost"); assert.strictEqual(it.effective, "shipped"); assert.ok(it.url.includes("israelpost"));
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "add", text: "RR123456789IL" })).created, false);   // dedupe
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "picked-up", id: it.id })).ok, true);
  v = await b.h["daily-shipments-load"](OWN, {});
  assert.strictEqual(v.items[0].archived, true); assert.strictEqual(v.items[0].pickedUp, true);
  assert.ok(v.items[0].history.length >= 2);
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "unarchive", id: it.id })).ok, true);
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "archive", id: it.id })).ok, true);
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "set-carrier", id: it.id, carrier: "nope" })).ok, false);
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "delete", id: it.id })).ok, true);
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "delete", id: it.id })).ok, false);
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, { op: "explode" })).ok, false);
  assert.strictEqual((await b.h["daily-shipments-op"](OWN, null)).ok, false);
});
t("IPC: key set/clear never echoes the key; stored encrypted; view says only whether a key exists", async () => {
  const b = boot();
  const bad = await b.h["daily-shipments-key"](OWN, { provider: "17track", key: "nope" });
  assert.strictEqual(bad.ok, false);
  const r = await b.h["daily-shipments-key"](OWN, { provider: "17track", key: SECRET });
  assert.deepStrictEqual(r, { ok: true, has: true });
  const v = await b.h["daily-shipments-load"](OWN, {});
  assert.strictEqual(v.provider.has17, true); assert.strictEqual(v.provider.live, true);
  assert.ok(!JSON.stringify(v).includes(SECRET) && !JSON.stringify(r).includes(SECRET));
  const files = fs.readdirSync(b.dataDir);
  assert.ok(files.includes("shipments-keys.bin"));
  for (const f of files) assert.ok(!fs.readFileSync(path.join(b.dataDir, f)).toString("latin1").includes(SECRET));
  for (const f of (fs.existsSync(path.join(b.root, "daily")) ? fs.readdirSync(path.join(b.root, "daily")) : [])) assert.ok(!fs.readFileSync(path.join(b.root, "daily", f)).toString("latin1").includes(SECRET), "key leaked into daily/" + f);
  assert.deepStrictEqual(await b.h["daily-shipments-key"](OWN, { provider: "17track", clear: true }), { ok: true, has: false });
  assert.strictEqual((await b.h["daily-shipments-load"](OWN, {})).provider.live, false);
});
t("service: mail scan merges parcels from mail objects, a poll timer exists only with a live provider", async () => {
  const dir = tmp();
  const file = path.join(dir, "shipments.json");
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, sleep: noSleep });
  const mails = [{ from: "FedEx <TrackingUpdates@fedex.com>", subject: "You're getting a shipment 878247853307", date: "2026-10-05T07:12:00Z", messageId: "<x1>", body: "From: Cartoni SPA, Rome, IT" }];
  const svc = S.createService({ file, readStore: D.readStore, writeJsonAtomic: D.writeJsonAtomic, tracker: tr, getMails: async () => mails, now: () => NOW, notices: [], say: () => {} });
  svc.syncTimer();
  assert.strictEqual(svc.hasTimer(), false);
  let v = await svc.load({ force: true });
  assert.strictEqual(v.items.length, 1);
  assert.strictEqual(v.items[0].merchant, "Cartoni SPA");
  v = await svc.load({ force: true });
  assert.strictEqual(v.items.length, 1);   // same mail again: still one
  tr.keys.set("17track", SECRET);
  svc.syncTimer();
  assert.strictEqual(svc.hasTimer(), true);
  svc.stop();
  assert.strictEqual(svc.hasTimer(), false);
});
t("service: a damaged store starts empty with a notice and keeps the bad file", async () => {
  const dir = tmp();
  const file = path.join(dir, "shipments.json");
  fs.writeFileSync(file, "{not json");
  const notices = [];
  const svc = S.createService({ file, readStore: D.readStore, writeJsonAtomic: D.writeJsonAtomic, tracker: T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe }), getMails: async () => [], now: () => NOW, notices, say: () => {} });
  const v = await svc.load({});
  assert.strictEqual(v.items.length, 0);
  assert.ok(notices.some((x) => /Shipments/.test(x)));
  assert.ok(fs.readdirSync(dir).some((f) => /corrupt/.test(f)));
});
t("service: provider failure never throws and is reported", async () => {
  const dir = tmp();
  const boom = { id: "fake", label: "x", needsKey: false, enabled: () => true, async track() { throw new Error("network down"); } };
  const tr = T.createTracker({ dataDir: tmp(), safeStorage: fakeSafe, fakeProvider: boom });
  const svc = S.createService({ file: path.join(dir, "s.json"), readStore: D.readStore, writeJsonAtomic: D.writeJsonAtomic, tracker: tr, getMails: async () => [], now: () => NOW, notices: [], say: () => {} });
  svc.op({ op: "add", text: "RR123456789IL" });
  const v = await svc.refreshNow();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.refresh.errors, 1);
  assert.ok(/network down/.test(v.refresh.firstError));
});

(async () => {
  for (const { name, fn } of queue) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.stack.split("\n").slice(0, 4).join("\n  ")); } }
  console.log(`shipments-track: ${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})();

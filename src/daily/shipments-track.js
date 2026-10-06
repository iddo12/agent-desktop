// My Daily - Shipments: tracking providers and key storage (main process only). Provider interface:
//   { id, label, needsKey, enabled(), track(items:[{number, carrier}]) -> Promise<{ results: {[number]: {events, state?, eta?}}, errors: {[number]: msg} }> }
// 'manual' never touches the network. '17track' is the real engine (register + gettrackinfo, <=40 per call). 'dhl' is a small
// real client (DHL Unified Tracking, needs its own key, polled at most every 6 h). 'ups' and 'fedex' are wired stubs that stay
// disabled (no key slot in the UI yet). A 'fake' provider exists for tests.
// Keys: kept ONLY here, encrypted with Electron safeStorage exactly like the Gmail token (gmail.js): never sent to the
// renderer, never logged, never put in a URL, never called from the browser side (17TRACK forbids that).
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const M = require("./shipments-model");

const HOSTS = new Set(["api.17track.net", "api-eu.dhl.com"]);
const POLL_MS = 3 * 3600000;
const DHL_MIN_MS = 6 * 3600000;
const BATCH = 40;
const MIN_GAP_MS = 400;           // 17TRACK allows 3 req/s; stay well under
const KEY_MAX = 200;

const clean = M.clean;

// small https JSON helper, host allow-listed, size and time capped. The key travels in a header, never in the URL.
function httpRequest(method, urlStr, { headers, body, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("bad url")); }
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) return reject(new Error("host not allowed"));
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: Object.assign({ "User-Agent": "AgentDesktop-MyDaily" }, headers || {}), timeout: timeoutMs || 20000 }, (res) => {
      let n = 0; const chunks = [];
      res.on("data", (c) => { n += c.length; if (n > 2 * 1024 * 1024) { req.destroy(new Error("response too large")); return; } chunks.push(c); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- key store (safeStorage)
function createKeyStore({ dataDir, safeStorage }) {
  const file = path.join(dataDir, "shipments-keys.bin");
  const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; } };
  function read() {
    try {
      const raw = fs.readFileSync(file);
      const v = JSON.parse(canEncrypt() ? safeStorage.decryptString(raw) : "");
      return v && typeof v === "object" ? v : {};
    } catch (e) { return {}; }
  }
  function write(v) {
    if (!canEncrypt()) throw new Error("This PC cannot encrypt the key, so it will not be stored.");
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    try { fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(v))); fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing */ } throw e; }
  }
  return {
    canEncrypt,
    get: (id) => { const k = read()[id]; return typeof k === "string" && k ? k : ""; },
    has: (id) => !!read()[id],
    set(id, key) {
      const k = String(key == null ? "" : key).trim();
      if (!/^[\x21-\x7e]{8,200}$/.test(k)) throw new Error("That does not look like a tracking key (8-" + KEY_MAX + " visible characters, no spaces).");
      const v = read(); v[id] = k; write(v);
    },
    clear(id) { const v = read(); delete v[id]; write(v); },
  };
}

// ---------------------------------------------------------------- providers
const manualProvider = { id: "manual", label: "Manual (no network)", needsKey: false, enabled: () => true, async track() { return { results: {}, errors: {} }; } };

// 17TRACK API v2.4. Response shape (defensive): { code:0, data:{ accepted:[{number, carrier, track_info}], rejected:[{number, error:{code,message}}] } }
function create17Track({ getKey, request, sleep }) {
  const call = request || httpRequest;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const post = async (endpoint, items) => {
    const key = getKey();
    if (!key) throw new Error("no key");
    const r = await call("POST", "https://api.17track.net/track/v2.4/" + endpoint, { headers: { "Content-Type": "application/json", "17token": key }, body: JSON.stringify(items) });
    if (r.status === 429) throw new Error("rate limited");
    if (r.status === 401 || r.status === 403) throw new Error("the tracking key was refused");
    if (!r.json || r.json.code !== 0) throw new Error("17TRACK answered " + r.status + (r.json && r.json.code != null ? " (code " + r.json.code + ")" : ""));
    return r.json.data || {};
  };
  const alreadyRegistered = (rej) => !!rej && (/registered/i.test(String(rej.error && rej.error.message)) || (rej.error && rej.error.code === -18019901));
  return {
    id: "17track", label: "17TRACK", needsKey: true, enabled: () => !!getKey(),
    async track(items) {
      const out = { results: {}, errors: {} };
      const list = items.filter((i) => i && i.number);
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const payload = batch.map((b) => { const o = { number: b.number }; const c = M.CARRIER_BY_ID[b.carrier]; if (c && c.t17) o.carrier = c.t17; return o; });
        try {
          const reg = await post("register", payload);
          for (const rej of reg.rejected || []) if (!alreadyRegistered(rej)) out.errors[rej.number] = clean(rej.error && rej.error.message, 120) || "rejected";
          await wait(MIN_GAP_MS);
          const info = await post("gettrackinfo", batch.map((b) => ({ number: b.number })));
          for (const acc of info.accepted || []) {
            const parsed = parseTrackInfo(acc);
            if (parsed) out.results[acc.number] = parsed;
          }
          for (const rej of info.rejected || []) if (!out.errors[rej.number]) out.errors[rej.number] = clean(rej.error && rej.error.message, 120) || "rejected";
        } catch (e) {
          for (const b of batch) out.errors[b.number] = clean(e && e.message, 120);
          if (/rate|refused|no key/i.test(String(e && e.message))) break;
        }
        if (i + BATCH < list.length) await wait(MIN_GAP_MS);
      }
      return out;
    },
  };
}
function parseTrackInfo(acc) {
  const ti = acc && acc.track_info;
  if (!ti || typeof ti !== "object") return null;
  const events = [];
  for (const p of (ti.tracking && ti.tracking.providers) || []) {
    for (const e of p.events || []) events.push({ at: Date.parse(e.time_iso || e.time_utc || ""), text: clean(e.description, 240), place: clean(e.location || [e.address && e.address.city, e.address && e.address.country].filter(Boolean).join(", "), 80) });
  }
  if (!events.length && ti.latest_event) events.push({ at: Date.parse(ti.latest_event.time_iso || ""), text: clean(ti.latest_event.description, 240), place: clean(ti.latest_event.location, 80) });
  const ls = ti.latest_status || {};
  const evs = events.filter((e) => e.text).map((e) => ({ at: Number.isFinite(e.at) ? e.at : null, text: e.text, place: e.place }));
  const state = M.stateFromTrack17(ls.status, ls.sub_status, evs.length ? evs.slice().sort((a, b) => (b.at || 0) - (a.at || 0))[0].text : "");
  const edd = ti.time_metrics && ti.time_metrics.estimated_delivery_date;
  const eta = edd && (edd.from || edd.to) ? Date.parse(edd.to || edd.from) : null;
  if (!evs.length && !state) return null;
  return { events: evs, state, eta: Number.isFinite(eta) ? eta : null };
}

// DHL Unified Tracking (needs its own free key, 250 calls/day, 1 call per 5 s). Unverified against the live API.
function createDhl({ getKey, request, sleep }) {
  const call = request || httpRequest;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    id: "dhl", label: "DHL", needsKey: true, minIntervalMs: DHL_MIN_MS, enabled: () => !!getKey(),
    async track(items) {
      const out = { results: {}, errors: {} };
      let first = true;
      for (const it of items.filter((i) => i && i.number).slice(0, 20)) {
        if (!first) await wait(5200);
        first = false;
        try {
          const r = await call("GET", "https://api-eu.dhl.com/track/shipments?trackingNumber=" + encodeURIComponent(it.number), { headers: { "DHL-API-Key": getKey() } });
          if (r.status === 404) { out.errors[it.number] = "not found yet"; continue; }
          if (r.status === 429) { out.errors[it.number] = "rate limited"; break; }
          if (r.status !== 200 || !r.json) { out.errors[it.number] = "DHL answered " + r.status; continue; }
          const sh = (r.json.shipments || [])[0];
          if (!sh) { out.errors[it.number] = "not found yet"; continue; }
          const evs = (sh.events || []).map((e) => ({ at: Date.parse(e.timestamp), text: clean([e.description, e.status].filter(Boolean)[0], 240), place: clean(e.location && e.location.address && e.location.address.addressLocality, 80) })).filter((e) => e.text);
          const st = sh.status && sh.status.statusCode;
          const state = st === "delivered" ? "delivered" : st === "failure" ? "exception_stuck" : st === "transit" ? M.stateFromText(evs[0] && evs[0].text) || "in_transit" : null;
          out.results[it.number] = { events: evs.map((e) => ({ at: Number.isFinite(e.at) ? e.at : null, text: e.text, place: e.place })), state, eta: sh.estimatedTimeOfDelivery ? Date.parse(sh.estimatedTimeOfDelivery) : null };
        } catch (e) { out.errors[it.number] = clean(e && e.message, 120); }
      }
      return out;
    },
  };
}
// UPS / FedEx: wired, disabled. They exist so the routing table is complete; no key slot is exposed yet (OAuth app needed).
const stubProvider = (id, label) => ({ id, label, needsKey: true, enabled: () => false, async track() { return { results: {}, errors: {} }; } });

// Dev-only provider for tests: script = { [number]: { events, state, eta } | Error }.
function createFake(script) {
  return { id: "fake", label: "Fake (tests)", needsKey: false, enabled: () => true, calls: [], async track(items) {
    this.calls.push(items.map((i) => i.number));
    const out = { results: {}, errors: {} };
    for (const it of items) { const v = script && script[it.number]; if (v instanceof Error) out.errors[it.number] = v.message; else if (v) out.results[it.number] = v; }
    return out;
  } };
}

// ---------------------------------------------------------------- manager
// Chooses a provider per shipment number and applies the results. Pure of electron: safeStorage is injected.
function createTracker({ dataDir, safeStorage, request, sleep, fakeProvider, log }) {
  const say = typeof log === "function" ? log : () => {};
  const keys = dataDir ? createKeyStore({ dataDir, safeStorage }) : { canEncrypt: () => false, get: () => "", has: () => false, set() { throw new Error("not available"); }, clear() {} };
  const p17 = create17Track({ getKey: () => keys.get("17track"), request, sleep });
  const pdhl = createDhl({ getKey: () => keys.get("dhl"), request, sleep });
  const providers = { manual: manualProvider, "17track": p17, dhl: pdhl, ups: stubProvider("ups", "UPS"), fedex: stubProvider("fedex", "FedEx") };
  if (fakeProvider) providers.fake = fakeProvider;
  let running = null;

  // which provider handles this number
  function route(num) {
    if (providers.fake) return providers.fake;
    if (num.carrier === "dhl" && pdhl.enabled()) return pdhl;
    if (p17.enabled()) return p17;
    return manualProvider;
  }
  const hasLiveProvider = () => !!providers.fake || p17.enabled() || pdhl.enabled();

  // Numbers due for a poll. Archived and delivered parcels are never polled; DHL ones at most every 6 h.
  function due(list, now, force) {
    const out = [];
    for (const s of list) {
      if (s.archived || s.state === "delivered") continue;
      for (const n of s.numbers) {
        if (n.carrier === "amazon") continue;   // only trackable inside Amazon
        const p = route(n);
        if (p.id === "manual") continue;
        if (!force && p.id === "dhl" && s.polledAt && now - s.polledAt < DHL_MIN_MS) continue;
        out.push({ shipment: s, number: n.no, carrier: n.carrier, provider: p });
      }
    }
    return out;
  }

  // Poll everything due and apply. Returns { polled, changed:[ids], errors, skipped }.
  async function refresh(list, now, opts) {
    if (running) return running;
    running = (async () => {
      const todo = due(list, now, opts && opts.force);
      const res = { polled: 0, changed: [], errors: {}, provider: hasLiveProvider() ? "live" : "none" };
      if (!todo.length) return res;
      const byProv = new Map();
      for (const t of todo) { if (!byProv.has(t.provider)) byProv.set(t.provider, []); byProv.get(t.provider).push(t); }
      for (const [prov, items] of byProv) {
        let r;
        try { r = await prov.track(items.map((i) => ({ number: i.number, carrier: i.carrier }))); }
        catch (e) { say("shipments " + prov.id + " failed: " + clean(e && e.message, 120)); r = { results: {}, errors: Object.fromEntries(items.map((i) => [i.number, clean(e && e.message, 120)])) }; }
        for (const it of items) {
          res.polled++;
          const hit = r.results[it.number];
          if (hit) {
            const before = JSON.stringify([it.shipment.state, it.shipment.lastEvent, it.shipment.eta]);
            M.applyEvents(it.shipment, hit.events, now, { state: hit.state, eta: hit.eta });
            if (JSON.stringify([it.shipment.state, it.shipment.lastEvent, it.shipment.eta]) !== before) { if (!res.changed.includes(it.shipment.id)) res.changed.push(it.shipment.id); }
          } else {
            it.shipment.polledAt = now; it.shipment.polledOk = !r.errors[it.number];
            if (r.errors[it.number]) res.errors[it.number] = r.errors[it.number];
          }
        }
      }
      return res;
    })().finally(() => { running = null; });
    return running;
  }

  return {
    keys, providers, route, due, refresh, hasLiveProvider, POLL_MS,
    status: () => ({ has17: keys.has("17track"), hasDhl: keys.has("dhl"), canEncrypt: keys.canEncrypt(), live: hasLiveProvider() }),
  };
}

module.exports = { createTracker, createKeyStore, create17Track, createDhl, createFake, manualProvider, parseTrackInfo, httpRequest, POLL_MS, DHL_MIN_MS, BATCH };

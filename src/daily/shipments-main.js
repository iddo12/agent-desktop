// My Daily - Shipments service (main process, no electron import: everything is injected so tests can drive it).
// Store: <root>/daily/shipments.json { version, items:[shipment], scannedAt, polledAt }. Mail is scanned when the tab opens or on
// refresh (never on a timer of its own); ONE low-frequency poll timer (3 h) exists only when a tracking key is stored.
"use strict";
const M = require("./shipments-model");
const E = require("./shipments-email");
const T = require("./shipments-track");

const SCAN_MIN_MS = 10 * 60000;
const MAX_MAILS = 400;

function createService({ file, settingsFile, readStore, writeJsonAtomic, tracker, getMails, now, say, notices, testMode }) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const log = typeof say === "function" ? say : () => {};
  let timer = null;
  let scanning = null;

  function loadStore() {
    const raw = readStore(file, { items: [] }, notices, "Shipments");
    let items = (Array.isArray(raw.items) ? raw.items : []).filter((x) => x && typeof x === "object").map((x) => M.makeShipment(x, clock()));
    if (testMode && !items.length && !raw.demoDone && process.env.AGENT_DESKTOP_SHIPMENTS_DEMO === "1") items = M.demoShipments(clock());
    return { items, scannedAt: Number(raw.scannedAt) || 0, polledAt: Number(raw.polledAt) || 0, lastError: String(raw.lastError || "").slice(0, 160) };
  }
  function save(st) {
    M.sweep(st.items, clock());
    writeJsonAtomic(file, { version: 1, items: st.items, scannedAt: st.scannedAt, polledAt: st.polledAt, lastError: st.lastError || "" });
  }
  const settings = () => M.cleanSettings(settingsFile ? readStore(settingsFile, {}, null, "Settings").shipments : null);

  // Read mail through the existing read-only mail code, extract parcels, merge. Returns the number of new/changed parcels.
  async function scan(st, force) {
    if (!force && st.scannedAt && clock() - st.scannedAt < SCAN_MIN_MS) return 0;
    if (scanning) return scanning;
    scanning = (async () => {
      let changed = 0;
      try {
        const mails = typeof getMails === "function" ? await getMails(clock()) : [];
        for (const mail of (mails || []).slice(0, MAX_MAILS)) {
          for (const cand of E.extractShipments(mail, clock())) {
            const r = M.mergeCandidate(st.items, cand, clock());
            if (r.created || r.changed) changed++;
          }
        }
        st.scannedAt = clock();
        st.lastError = "";
      } catch (e) { st.lastError = M.clean(e && e.message, 120); log("shipments mail scan failed: " + st.lastError); }
      return changed;
    })().finally(() => { scanning = null; });
    return scanning;
  }

  function view(st) {
    const t = clock();
    const sd = settings().stuckDays;
    const tr = tracker.status();
    const items = st.items.map((s) => Object.assign({}, s, {
      effective: M.effectiveState(s, t, sd), stuck: M.isStuck(s, t, sd), action: M.actionText(s, t, sd),
      carrierName: M.carrierName(s.carrier),
      numbers: s.numbers.map((n) => ({ no: n.no, carrier: n.carrier, carrierName: M.carrierName(n.carrier), url: M.trackUrl(n.carrier, n.no) })),
      url: s.numbers.length ? M.trackUrl(s.numbers[s.numbers.length - 1].carrier, s.numbers[s.numbers.length - 1].no) : "",
      note2: s.carrier === "amazon" ? "Tracked inside Amazon" : "",
      events: (s.events || []).slice(0, 8),
    }));
    return {
      ok: true, now: t, items, stuckDays: sd,
      counts: { needs: items.filter((x) => !x.archived && ["action_pay", "action_pickup", "exception_stuck"].includes(x.effective)).length, active: items.filter((x) => !x.archived).length, archived: items.filter((x) => x.archived).length },
      provider: { live: tr.live, has17: tr.has17, hasDhl: tr.hasDhl, canEncrypt: tr.canEncrypt, polledAt: st.polledAt || null, nextPollAt: timer && st.polledAt ? st.polledAt + T.POLL_MS : null, scannedAt: st.scannedAt || null, lastError: st.lastError || "" },
      states: M.STATE_LABEL,
    };
  }

  // Poll providers (stale > 3 h, or forced) and persist. Never throws.
  async function poll(st, force) {
    if (!tracker.hasLiveProvider()) return null;
    const t = clock();
    if (!force && st.polledAt && t - st.polledAt < T.POLL_MS - 60000) return null;
    try {
      const r = await tracker.refresh(st.items, t, { force });
      st.polledAt = t;
      return r;
    } catch (e) { st.lastError = M.clean(e && e.message, 120); return null; }
  }

  async function load(args) {
    const st = loadStore();
    const a = args || {};
    const found = await scan(st, !!a.force);
    if (found || a.force) save(st); else if (!st.scannedAt) save(st);
    // a stale poll in the background (does not delay the answer)
    if (tracker.hasLiveProvider() && (!st.polledAt || clock() - st.polledAt >= T.POLL_MS)) {
      poll(st, false).then((r) => { if (r) { try { save(st); } catch (e) { /* next time */ } } }).catch(() => {});
    }
    return view(st);
  }

  async function refreshNow() {
    const st = loadStore();
    await scan(st, true);
    const r = await poll(st, true);
    save(st);
    const v = view(st);
    v.refresh = r ? { polled: r.polled, changed: r.changed.length, errors: Object.keys(r.errors).length, firstError: Object.values(r.errors)[0] || "" } : { polled: 0, changed: 0, errors: 0, firstError: "" };
    return v;
  }

  function op(a) {
    const args = a && typeof a === "object" ? a : {};
    const st = loadStore();
    const t = clock();
    const find = () => st.items.find((x) => x.id === args.id);
    switch (args.op) {
      case "add": {
        const p = E.parseAddInput(args.text);
        if (!p.ok) return { ok: false, reason: p.reason };
        const r = M.mergeCandidate(st.items, { numbers: p.numbers, carrier: p.carrier, title: p.title, state: "shipped", at: t, source: "manual" }, t);
        r.shipment.source = r.created ? "manual" : r.shipment.source;
        save(st);
        return { ok: true, id: r.shipment.id, created: r.created };
      }
      case "archive": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; M.archiveShipment(s, t, "manual"); break; }
      case "unarchive": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; M.unarchiveShipment(s, t); break; }
      case "picked-up": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; M.markPickedUp(s, t); break; }
      case "delete": {
        const i = st.items.findIndex((x) => x.id === args.id);
        if (i < 0) return { ok: false, reason: "That shipment is gone." };
        st.items.splice(i, 1); break;
      }
      case "set-carrier": {
        const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." };
        if (!M.CARRIER_BY_ID[args.carrier]) return { ok: false, reason: "Unknown carrier." };
        s.carrier = args.carrier; for (const n of s.numbers) n.carrier = args.carrier; s.updated = t; s.polledAt = null; break;
      }
      case "note": { const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." }; s.note = M.clean(args.note, 200); s.updated = t; break; }
      case "add-number": {
        const s = find(); if (!s) return { ok: false, reason: "That shipment is gone." };
        const p = E.parseAddInput(args.text);
        if (!p.ok) return { ok: false, reason: p.reason };
        M.mergeCandidate(st.items.filter((x) => x === s), { numbers: p.numbers, orderId: s.orderId, merchant: s.merchant, at: t }, t);
        s.numbers = s.numbers.slice(0, 6); break;
      }
      default: return { ok: false, reason: "Unknown action." };
    }
    save(st);
    return { ok: true };
  }

  function setKey(args) {
    const a = args && typeof args === "object" ? args : {};
    const id = a.provider === "dhl" ? "dhl" : "17track";
    try {
      if (a.clear) tracker.keys.clear(id); else tracker.keys.set(id, a.key);
    } catch (e) { return { ok: false, reason: M.clean(e && e.message, 160) }; }
    syncTimer();
    // The key is never echoed back, only whether one is stored.
    return { ok: true, has: tracker.keys.has(id) };
  }

  // One low-frequency poll timer, only while a live provider exists. unref'd so it never keeps the app alive.
  function syncTimer() {
    if (tracker.hasLiveProvider()) {
      if (!timer) { timer = setInterval(() => { runTimed().catch(() => {}); }, T.POLL_MS); if (timer.unref) timer.unref(); }
    } else if (timer) { clearInterval(timer); timer = null; }
  }
  async function runTimed() {
    const st = loadStore();
    await scan(st, true);
    await poll(st, true);
    save(st);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { load, refreshNow, op, setKey, syncTimer, stop, runTimed, _loadStore: loadStore, hasTimer: () => !!timer };
}

module.exports = { createService };

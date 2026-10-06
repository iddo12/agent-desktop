// My Daily - Shipments (pure logic, no electron, no network). Carrier detection from a tracking number, the normalised
// state list and its precedence, text-to-state keyword rules (English + Hebrew), the "stuck" rule, merge/dedupe of a parcel
// that has more than one number, and the archive rules. Sources: research/tracking_sources.md (2026-10-06). Regexes marked
// [K] there are unverified against real mail; extend them when real samples arrive.
"use strict";

const DAY = 86400000;
const HOUR = 3600000;
const STUCK_DAYS_DEFAULT = 5;
const ARCHIVE_KEEP_DAYS = 365;     // archived parcels (history) kept this long, then dropped
const MAX_ITEMS = 500;
const MAX_EVENTS = 40;

// Progress order, lowest first. exception_stuck is the "something is wrong" state and ranks highest.
const STATES = ["ordered", "shipped", "in_transit", "customs", "action_pay", "action_pickup", "out_for_delivery", "delivered", "exception_stuck"];
const STATE_LABEL = {
  ordered: "Ordered", shipped: "Shipped", in_transit: "In transit", customs: "In customs", action_pay: "Pay now",
  action_pickup: "Pick up", out_for_delivery: "Out for delivery", delivered: "Delivered", exception_stuck: "Problem / stuck",
};
const NEEDS_ACTION = new Set(["action_pay", "action_pickup", "exception_stuck"]);
const rankState = (s) => Math.max(0, STATES.indexOf(s));

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// ---------------------------------------------------------------- carriers
// order matters: most specific first. `url` is the carrier's own tracking page ({n} = number).
const CARRIERS = [
  { id: "ups", name: "UPS", re: [/^1Z[0-9A-Z]{16}$/], url: "https://www.ups.com/track?tracknum={n}", t17: 100002 },
  { id: "amazon", name: "Amazon Logistics", re: [/^TB[ACM]\d{12}$/], url: "", t17: 0, note: "Tracked inside Amazon" },
  { id: "cainiao", name: "Cainiao / AliExpress", re: [/^LP\d{10,20}[A-Z]{0,2}$/], url: "https://global.cainiao.com/newDetail.htm?mailNoList={n}", t17: 190271 },
  { id: "yunexpress", name: "YunExpress", re: [/^YT\d{16}$/], url: "https://www.yuntrack.com/Track/Detail/{n}", t17: 190008 },
  { id: "dhl_ecom", name: "DHL eCommerce", re: [/^(JJD|JVGL)[0-9A-Z]{10,24}$/, /^GM\d{16,18}$/], url: "https://www.dhl.com/global-en/home/tracking.html?tracking-id={n}", t17: 7041 },
  { id: "israelpost", name: "Israel Post / UPU", re: [/^[A-Z]{2}\d{9}[A-Z]{2}$/], url: "https://doar.israelpost.co.il/en/deliverytracking?itemcode={n}", t17: 9061 },
  { id: "dhl", name: "DHL Express", re: [/^\d{10}$/, /^\d{11}$/], url: "https://www.dhl.com/global-en/home/tracking.html?tracking-id={n}", t17: 100001, weak: true },
  { id: "fedex", name: "FedEx", re: [/^\d{12}$/, /^\d{15}$/, /^\d{20}$/, /^\d{22}$/], url: "https://www.fedex.com/fedextrack/?trknbr={n}", t17: 100003, weak: true },
  // carriers with no number format: chosen from the sender / link host, or by the user
  { id: "aramex", name: "Aramex", re: [], url: "https://www.aramex.com/track/results?ShipmentNumber={n}", t17: 100004 },
  { id: "exelot", name: "Exelot", re: [], url: "", t17: 100032 },
  { id: "gaash", name: "GAASH", re: [], url: "", t17: 100145 },
  { id: "orian", name: "ORIAN", re: [], url: "", t17: 100791 },
  { id: "cheetah", name: "Cheetah", re: [], url: "https://chitadelivery.co.il/", t17: 101219 },
  { id: "hfd", name: "HFD", re: [], url: "https://www.hfd.co.il/", t17: 100327 },
  { id: "other", name: "Other / unknown", re: [], url: "", t17: 0 },
];
const CARRIER_BY_ID = Object.fromEntries(CARRIERS.map((c) => [c.id, c]));
const carrierName = (id) => (CARRIER_BY_ID[id] || CARRIER_BY_ID.other).name;

const normNumber = (v) => String(v == null ? "" : v).replace(/[\s\-.]/g, "").toUpperCase().slice(0, 40);

// -> { carrier, confidence: "high"|"low"|"none" }. `hint` is a carrier id from the sender or a link host: it settles the
// ambiguous digit-only formats (a 12-digit number is FedEx only when FedEx sent the mail).
function detectCarrier(number, hint) {
  const n = normNumber(number);
  if (!n) return { carrier: "other", confidence: "none" };
  const matches = CARRIERS.filter((c) => c.re.some((r) => r.test(n)));
  const strong = matches.find((c) => !c.weak);
  if (strong) return { carrier: strong.id, confidence: "high" };
  if (hint && CARRIER_BY_ID[hint] && hint !== "other") {
    if (matches.some((c) => c.id === hint) || !matches.length) return { carrier: hint, confidence: matches.some((c) => c.id === hint) ? "high" : "low" };
    return { carrier: matches[0].id, confidence: "low" };
  }
  if (matches.length) return { carrier: matches[0].id, confidence: "low" };
  return { carrier: "other", confidence: "none" };
}

// Is this string plausibly a tracking number at all (used for manual add and labelled mail text)?
function plausibleNumber(v) {
  const n = normNumber(v);
  return /^[A-Z0-9]{8,30}$/.test(n) && /\d/.test(n) && !/^\d{3}\d{7}\d{7}$/.test(n) /* Amazon order id without dashes is 17 digits: skip */ ? true : false;
}

function trackUrl(carrier, number) {
  const c = CARRIER_BY_ID[carrier];
  if (!c || !c.url) return "";
  return c.url.replace("{n}", encodeURIComponent(normNumber(number)));
}

// ---------------------------------------------------------------- text -> state
// Case-insensitive substring/regex rules, checked in this order (research section 4). Hebrew terms are suggestions to validate.
const RULES = [
  ["in_transit", /\b(released from customs|cleared (?:through |by )?customs|customs clearance (?:completed|processed|cleared)|clearance (?:completed|cleared))\b/i],
  ["action_pay", /(customs (?:fee|duty|charge|payment)|import (?:duty|tax|fee)|\bduties?\b.*\b(?:due|pay|owed)|\bVAT\b.*\b(?:due|pay)|payment (?:is )?(?:required|due)|awaiting payment|pay(?:ment)? (?:to release|before delivery)|release fee|brokerage|ממתין לתשלום|תשלום מכס|דמי שחרור|מע"?מ|לתשלום)/i],
  ["action_pickup", /(ready (?:for|to be) (?:pick ?-?up|collect)|available for (?:pick ?-?up|collection)|awaiting (?:pick ?-?up|collection)|pick-?up point|collection point|parcel locker|\blocker\b|notice left|arrived at (?:the )?post office|held at (?:the )?post office|waiting (?:for you )?at|הגיע לסניף|מוכנה? לאיסוף|נקודת איסוף|לוקר|ממתין לאיסוף|ממתינה לאיסוף)/i],
  ["exception_stuck", /(exception|\blost\b|damaged|returned to sender|return to sender|\bunclaimed\b|\brefused\b|forbidden to import|invalid address|address (?:problem|issue)|\bheld\b|clearance delay|\bdelays?\b|\bdelayed\b|undeliverable|not delivered|undelivered|delivery (?:attempt )?(?:failed|unsuccessful)|unable to deliver|הוחזר לשולח|חריגה|נעצר|עיכוב)/i],
  ["delivered", /(\bdelivered\b|\bsigned for\b|left at (?:the )?(?:front door|door|mailbox|reception)|\bנמסר\b|נמסרה)/i],
  ["out_for_delivery", /(out for delivery|with (?:the )?(?:delivery )?courier|on (?:its|the) way to you today|יצא לחלוקה|יצאה לחלוקה|בדרך אליך היום)/i],
  ["customs", /(customs|clearance|import processing|\bמכס\b|שחרור)/i],
  ["in_transit", /(in transit|on (?:its|the) way|departed|\barrived at\b|sorting|forwarded|dispatched|in progress|left the|processed at|בדרך|בתהליך)/i],
  ["shipped", /(label created|shipment information (?:sent|received)|information received|has shipped|\bshipped\b|accepted by|picked up by|getting a shipment|sending you a (?:shipment|package)|is on its way|נשלח|נשלחה)/i],
  ["ordered", /(order (?:confirmation|received|placed)|thank you for your order|we(?:'| ha)ve received your order|הזמנתך התקבלה)/i],
];
function stateFromText(text) {
  const t = String(text || "");
  if (!t.trim()) return null;
  for (const [state, re] of RULES) if (re.test(t)) return state;
  return null;
}

// 17TRACK normalised statuses -> app state. `text` (the event description) can sharpen an Exception or InTransit status.
function stateFromTrack17(status, subStatus, text) {
  const s = String(status || ""), sub = String(subStatus || "");
  const byText = stateFromText(text);
  switch (s) {
    case "Delivered": return "delivered";
    case "OutForDelivery": return "out_for_delivery";
    case "AvailableForPickup": return "action_pickup";
    case "DeliveryFailure": return byText === "action_pickup" || byText === "action_pay" ? byText : (/notice|pickup|collect/i.test(sub) ? "action_pickup" : "exception_stuck");
    case "Exception": return byText === "action_pay" || byText === "action_pickup" ? byText : "exception_stuck";
    case "Expired": return "exception_stuck";
    case "InfoReceived": return "shipped";
    case "InTransit":
      if (byText === "action_pay" || byText === "action_pickup") return byText;
      if (/customs/i.test(sub)) return "customs";
      return byText === "customs" ? "customs" : "in_transit";
    case "NotFound": default: return null;
  }
}

// ---------------------------------------------------------------- shipment record
let idSeq = 0;
const newId = (now) => "s" + (now || Date.now()).toString(36) + (++idSeq).toString(36) + Math.random().toString(36).slice(2, 5);

function isoOrNull(v) { const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function atMs(v) { const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? t : null; }

// Build a clean shipment from loose input. numbers: [{no, carrier}] (carrier optional -> detected).
function makeShipment(input, now) {
  const inp = input || {};
  const nums = [];
  for (const x of Array.isArray(inp.numbers) ? inp.numbers : []) {
    const no = normNumber(typeof x === "string" ? x : x && x.no);
    if (!no || nums.some((y) => y.no === no)) continue;
    const c = (x && x.carrier && CARRIER_BY_ID[x.carrier]) ? x.carrier : detectCarrier(no, inp.carrier).carrier;
    nums.push({ no, carrier: c });
  }
  const t = now || Date.now();
  const state = STATES.includes(inp.state) ? inp.state : "ordered";
  const s = {
    id: clean(inp.id, 40) || newId(t),
    numbers: nums,
    carrier: (inp.carrier && CARRIER_BY_ID[inp.carrier]) ? inp.carrier : (nums[0] ? nums[0].carrier : "other"),
    orderId: clean(inp.orderId, 40),
    merchant: clean(inp.merchant, 60),
    title: clean(inp.title, 120),
    from: clean(inp.from, 80), to: clean(inp.to, 40),
    eta: isoOrNull(inp.eta), etaText: clean(inp.etaText, 40),
    state, stateAt: atMs(inp.stateAt) || t,
    lastEvent: inp.lastEvent && typeof inp.lastEvent === "object" ? { text: clean(inp.lastEvent.text, 240), place: clean(inp.lastEvent.place, 80), at: atMs(inp.lastEvent.at) } : null,
    lastChangeAt: atMs(inp.lastChangeAt) || t,
    events: [],
    history: [],
    source: ["email", "manual", "track"].includes(inp.source) ? inp.source : "manual",
    msgIds: Array.isArray(inp.msgIds) ? inp.msgIds.map((m) => clean(m, 200)).filter(Boolean).slice(0, 20) : [],
    amountDue: clean(inp.amountDue, 40),
    pickupBy: isoOrNull(inp.pickupBy),
    note: clean(inp.note, 200),
    pickedUp: !!inp.pickedUp,
    archived: !!inp.archived, archivedAt: atMs(inp.archivedAt),
    added: atMs(inp.added) || t, updated: atMs(inp.updated) || t,
    polledAt: atMs(inp.polledAt), polledOk: inp.polledOk == null ? null : !!inp.polledOk,
  };
  if (Array.isArray(inp.events)) s.events = inp.events.map(cleanEvent).filter(Boolean).slice(0, MAX_EVENTS);
  if (Array.isArray(inp.history)) s.history = inp.history.filter((h) => h && STATES.includes(h.state)).map((h) => ({ at: atMs(h.at) || t, state: h.state, why: clean(h.why, 60) })).slice(-60);
  if (!s.history.length) s.history.push({ at: s.stateAt, state: s.state, why: s.source });
  return s;
}
function cleanEvent(e) {
  if (!e || typeof e !== "object") return null;
  const text = clean(e.text, 240);
  if (!text) return null;
  return { at: atMs(e.at), text, place: clean(e.place, 80) };
}

// ---------------------------------------------------------------- state updates
// Set the state when `evidenceAt` is not older than what we already know. Delivered is sticky against OLDER evidence only.
function setState(s, state, evidenceAt, why, now) {
  if (!STATES.includes(state)) return false;
  const at = evidenceAt || now;
  if (state === s.state) { if (at > s.stateAt) s.stateAt = at; return false; }
  if (at < s.stateAt) return false;       // an older event never rewrites a newer one
  s.state = state; s.stateAt = at; s.lastChangeAt = Math.max(s.lastChangeAt || 0, at); s.updated = now;
  s.history.push({ at, state, why: clean(why, 60) });
  if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
  if (state === "delivered") archiveShipment(s, now, "delivered");
  else if (s.archived && s.archivedAt != null && !s.pickedUp) { s.archived = false; s.archivedAt = null; }   // a newer non-final event reopens it
  return true;
}

// Apply a batch of tracking events (newest or oldest first, either way) from a provider. Returns true when anything changed.
function applyEvents(s, events, now, info) {
  const evs = (events || []).map(cleanEvent).filter(Boolean);
  let changed = false;
  if (evs.length) {
    evs.sort((a, b) => (b.at || 0) - (a.at || 0));
    const newest = evs[0];
    const prev = s.lastEvent;
    if (!prev || newest.text !== prev.text || newest.at !== prev.at) {
      s.lastEvent = newest; s.lastChangeAt = Math.max(newest.at || now, 0) || now; s.updated = now; changed = true;
    }
    s.events = evs.slice(0, MAX_EVENTS);
  }
  if (info && info.state) { if (setState(s, info.state, info.stateAt || (evs[0] && evs[0].at) || now, "track", now)) changed = true; }
  else if (evs.length) { const st = stateFromText(evs[0].text); if (st && setState(s, st, evs[0].at || now, "event", now)) changed = true; }
  if (info && info.eta) { const e = isoOrNull(info.eta); if (e && e !== s.eta) { s.eta = e; changed = true; } }
  s.polledAt = now; s.polledOk = true;
  return changed;
}

// The state to SHOW: in-progress parcels with no event change for stuckDays become exception_stuck (derived, not stored).
function effectiveState(s, now, stuckDays) {
  if (!s) return "ordered";
  if (s.archived || s.state === "delivered" || NEEDS_ACTION.has(s.state) || s.state === "out_for_delivery") return s.state;
  if (s.state === "ordered") return s.state;
  const days = stuckDays || STUCK_DAYS_DEFAULT;
  if (now - (s.lastChangeAt || s.stateAt || 0) > days * DAY) return "exception_stuck";
  return s.state;
}
function isStuck(s, now, stuckDays) { return !!s && effectiveState(s, now, stuckDays) === "exception_stuck" && s.state !== "exception_stuck"; }

// ---------------------------------------------------------------- archive
function archiveShipment(s, now, why) {
  if (s.archived) return false;
  s.archived = true; s.archivedAt = now; s.updated = now;
  if (why === "picked_up") s.pickedUp = true;
  return true;
}
function unarchiveShipment(s, now) {
  if (!s.archived) return false;
  s.archived = false; s.archivedAt = null; s.pickedUp = false; s.updated = now;
  return true;
}
function markPickedUp(s, now) {
  s.pickedUp = true;
  setState(s, "delivered", now, "picked up by you", now);
  s.state = "delivered";
  archiveShipment(s, now, "picked_up");
  return true;
}
// Drop archived entries older than ARCHIVE_KEEP_DAYS and cap the list. Returns true when changed.
function sweep(list, now) {
  const before = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.archived && s.archivedAt != null && now - s.archivedAt > ARCHIVE_KEEP_DAYS * DAY) list.splice(i, 1);
  }
  if (list.length > MAX_ITEMS) {
    list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    list.length = MAX_ITEMS;
  }
  return list.length !== before;
}

// ---------------------------------------------------------------- merge / dedupe
// A parcel can have two numbers (AliExpress LP.. then an Israel Post RR..). Match an incoming candidate to an existing
// shipment by any shared (normalised) number, else by the same order id from the same merchant with no number conflict.
function findMatch(list, cand) {
  const nos = new Set((cand.numbers || []).map((x) => normNumber(typeof x === "string" ? x : x.no)).filter(Boolean));
  for (const s of list) if (s.numbers.some((x) => nos.has(x.no))) return s;
  if (cand.orderId) {
    const o = String(cand.orderId).toLowerCase();
    for (const s of list) {
      if (s.orderId && s.orderId.toLowerCase() === o && (!cand.merchant || !s.merchant || s.merchant.toLowerCase() === String(cand.merchant).toLowerCase())) return s;
    }
  }
  return null;
}

// Merge one candidate into the list. -> { shipment, created, changed }. Candidate `at` (mail date) orders the evidence.
function mergeCandidate(list, cand, now) {
  const at = atMs(cand.at) || now;
  const cmsg = cand.msgId ? [cand.msgId] : (cand.msgIds || []);
  let s = findMatch(list, cand);
  if (s && cmsg.length && cmsg.every((m) => s.msgIds.includes(m))) return { shipment: s, created: false, changed: false };   // same mail twice
  if (!s) {
    s = makeShipment(Object.assign({}, cand, { state: cand.state || "ordered", stateAt: at, lastChangeAt: at, source: cand.source || "email", msgIds: cmsg, added: now, updated: now }), now);
    if (s.state === "delivered") archiveShipment(s, now, "delivered");
    list.push(s);
    return { shipment: s, created: true, changed: true };
  }
  let changed = false;
  for (const x of cand.numbers || []) {
    const no = normNumber(typeof x === "string" ? x : x.no);
    if (!no || s.numbers.some((y) => y.no === no)) continue;
    s.numbers.push({ no, carrier: (x && x.carrier && CARRIER_BY_ID[x.carrier]) ? x.carrier : detectCarrier(no, cand.carrier).carrier });
    changed = true;
  }
  // The newest number is normally the one to show (the final-leg carrier)
  if (changed) s.carrier = s.numbers[s.numbers.length - 1].carrier;
  for (const k of ["orderId", "merchant", "title", "from", "to", "amountDue"]) { if (cand[k] && !s[k]) { s[k] = clean(cand[k], 120); changed = true; } }
  if (cand.eta) { const e = isoOrNull(cand.eta); if (e && (!s.eta || at >= s.stateAt)) { if (s.eta !== e) { s.eta = e; changed = true; } } }
  if (cand.pickupBy) { const e = isoOrNull(cand.pickupBy); if (e && e !== s.pickupBy) { s.pickupBy = e; changed = true; } }
  if (cand.amountDue && cand.state === "action_pay" && s.amountDue !== clean(cand.amountDue, 40)) { s.amountDue = clean(cand.amountDue, 40); changed = true; }
  // a mail never beats a newer tracking event, but does beat an older one
  if (cand.state && setState(s, cand.state, at, "email", now)) changed = true;
  for (const m of cmsg) if (!s.msgIds.includes(m)) { s.msgIds.push(m); s.msgIds = s.msgIds.slice(-20); changed = true; }
  if (changed) s.updated = now;
  return { shipment: s, created: false, changed };
}

// Merge two existing shipments that turned out to be the same parcel (user action or number discovery). Keeps `a`.
function mergeShipments(a, b, now) {
  for (const x of b.numbers) if (!a.numbers.some((y) => y.no === x.no)) a.numbers.push(x);
  for (const k of ["orderId", "merchant", "title", "from", "to", "amountDue", "note"]) if (!a[k] && b[k]) a[k] = b[k];
  if (!a.eta && b.eta) a.eta = b.eta;
  a.msgIds = Array.from(new Set(a.msgIds.concat(b.msgIds))).slice(-20);
  if ((b.stateAt || 0) > (a.stateAt || 0)) { a.state = b.state; a.stateAt = b.stateAt; }
  if (b.lastEvent && (!a.lastEvent || (b.lastEvent.at || 0) > (a.lastEvent.at || 0))) a.lastEvent = b.lastEvent;
  a.lastChangeAt = Math.max(a.lastChangeAt || 0, b.lastChangeAt || 0);
  a.history = a.history.concat(b.history).sort((x, y) => x.at - y.at).slice(-60);
  a.updated = now;
  return a;
}

// ---------------------------------------------------------------- grouping for the view
// -> { needs, transit, delivered } each sorted; delivered = archived list. `needs` holds action_pay/pickup/exception and stuck.
function groupShipments(list, now, stuckDays) {
  const needs = [], transit = [], archive = [];
  for (const s of list) {
    if (s.archived) { archive.push(s); continue; }
    const st = effectiveState(s, now, stuckDays);
    if (NEEDS_ACTION.has(st)) needs.push(s); else transit.push(s);
  }
  const byUrgency = (a, b) => {
    const pa = a.pickupBy ? Date.parse(a.pickupBy) : Infinity, pb = b.pickupBy ? Date.parse(b.pickupBy) : Infinity;
    return pa - pb || (b.updated || 0) - (a.updated || 0);
  };
  needs.sort(byUrgency);
  transit.sort((a, b) => {
    const ea = a.eta ? Date.parse(a.eta) : Infinity, eb = b.eta ? Date.parse(b.eta) : Infinity;
    return ea - eb || (b.updated || 0) - (a.updated || 0);
  });
  archive.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  return { needs, transit, archive };
}

// Reason line for the "action needed" chip.
function actionText(s, now, stuckDays) {
  const st = effectiveState(s, now, stuckDays);
  if (st === "action_pay") return s.amountDue ? `Pay ${s.amountDue} to release it` : "A payment is needed to release it";
  if (st === "action_pickup") {
    if (s.pickupBy) { const d = Math.ceil((Date.parse(s.pickupBy) - now) / DAY); return d < 0 ? "Pickup deadline passed" : d === 0 ? "Pick up today" : `Pick up within ${d} day${d === 1 ? "" : "s"}`; }
    return "Ready to pick up";
  }
  if (st === "exception_stuck") {
    if (isStuck(s, now, stuckDays)) { const d = Math.floor((now - (s.lastChangeAt || 0)) / DAY); return `No update for ${d} days`; }
    return "Carrier reports a problem";
  }
  return "";
}

// ---------------------------------------------------------------- settings / demo data
function cleanSettings(v) {
  const o = v && typeof v === "object" ? v : {};
  const sd = Number(o.stuckDays);
  return { stuckDays: Number.isFinite(sd) ? Math.max(2, Math.min(30, Math.round(sd))) : STUCK_DAYS_DEFAULT };
}

// Test-mode demo parcels (sandbox screenshots / UI tests). Never used outside test mode.
function demoShipments(now) {
  const mk = (o) => makeShipment(o, now);
  return [
    mk({ id: "d1", numbers: [{ no: "878247853307" }], carrier: "fedex", merchant: "Cartoni SPA", title: "Camera head (from Rome)", from: "Cartoni SPA, Rome", state: "in_transit", stateAt: now - 2 * DAY, lastChangeAt: now - 2 * DAY, eta: new Date(now + 2 * DAY).toISOString(), lastEvent: { text: "Departed FedEx hub", place: "Cologne, DE", at: now - 2 * DAY }, source: "email" }),
    mk({ id: "d2", numbers: [{ no: "RR123456789IL" }, { no: "LP00123456789012345678" }], carrier: "israelpost", merchant: "AliExpress", title: "SD card reader", state: "action_pickup", stateAt: now - DAY, lastChangeAt: now - DAY, pickupBy: new Date(now + 6 * DAY).toISOString(), lastEvent: { text: "מוכן לאיסוף בסניף הדואר", place: "Haifa", at: now - DAY }, source: "email" }),
    mk({ id: "d3", numbers: [{ no: "1Z999AA10123456784" }], merchant: "B&H", state: "action_pay", amountDue: "NIS 148", stateAt: now - 3 * HOUR, lastChangeAt: now - 3 * HOUR, lastEvent: { text: "Customs duty due before delivery", place: "Tel Aviv", at: now - 3 * HOUR }, source: "email" }),
    mk({ id: "d4", numbers: [{ no: "LP00987654321098765432" }], merchant: "AliExpress", state: "in_transit", stateAt: now - 9 * DAY, lastChangeAt: now - 9 * DAY, lastEvent: { text: "Arrived at sorting center", place: "Guangzhou", at: now - 9 * DAY }, source: "email" }),
    mk({ id: "d5", numbers: [{ no: "TBA123456789012" }], merchant: "Amazon", state: "out_for_delivery", stateAt: now - HOUR, lastChangeAt: now - HOUR, source: "email" }),
    mk({ id: "d6", numbers: [{ no: "8000000001" }], carrier: "dhl", merchant: "iHerb", state: "delivered", stateAt: now - 4 * DAY, lastChangeAt: now - 4 * DAY, archived: true, archivedAt: now - 4 * DAY, lastEvent: { text: "Delivered", place: "Haifa", at: now - 4 * DAY }, source: "email" }),
  ];
}

module.exports = {
  STATES, STATE_LABEL, NEEDS_ACTION, CARRIERS, CARRIER_BY_ID, STUCK_DAYS_DEFAULT, ARCHIVE_KEEP_DAYS, MAX_ITEMS,
  rankState, clean, normNumber, detectCarrier, plausibleNumber, trackUrl, carrierName,
  stateFromText, stateFromTrack17, makeShipment, cleanEvent, setState, applyEvents, effectiveState, isStuck,
  archiveShipment, unarchiveShipment, markPickedUp, sweep, findMatch, mergeCandidate, mergeShipments,
  groupShipments, actionText, cleanSettings, demoShipments,
};

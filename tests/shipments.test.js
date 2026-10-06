// node tests/shipments.test.js - My Daily Shipments pure model (src/daily/shipments-model.js)
"use strict";
const assert = require("assert");
const M = require("../src/daily/shipments-model");
const DAY = 86400000;
const NOW = Date.parse("2026-10-06T10:00:00Z");
let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.stack.split("\n").slice(0, 3).join("\n  ")); } }

t("carrier detection from number formats", () => {
  assert.strictEqual(M.detectCarrier("1Z 999 AA1 0123 4567 84").carrier, "ups");
  assert.strictEqual(M.detectCarrier("rr123456789il").carrier, "israelpost");
  assert.strictEqual(M.detectCarrier("LP00123456789012345678").carrier, "cainiao");
  assert.strictEqual(M.detectCarrier("TBA123456789012").carrier, "amazon");
  assert.strictEqual(M.detectCarrier("YT1234567890123456").carrier, "yunexpress");
  assert.strictEqual(M.detectCarrier("JJD0099999999999").carrier, "dhl_ecom");
  assert.strictEqual(M.detectCarrier("garbage").carrier, "other");
});
t("ambiguous digit numbers use the sender hint, else low confidence", () => {
  assert.deepStrictEqual(M.detectCarrier("878247853307", "fedex"), { carrier: "fedex", confidence: "high" });
  assert.strictEqual(M.detectCarrier("878247853307").confidence, "low");
  assert.strictEqual(M.detectCarrier("1234567890", "dhl").carrier, "dhl");
  assert.strictEqual(M.detectCarrier("1234567890").carrier, "dhl");
});
t("carrier page urls and number normalisation", () => {
  assert.strictEqual(M.normNumber(" 8782-4785 3307 "), "878247853307");
  assert.strictEqual(M.trackUrl("fedex", "878247853307"), "https://www.fedex.com/fedextrack/?trknbr=878247853307");
  assert.strictEqual(M.trackUrl("amazon", "TBA123456789012"), "");
  assert.ok(M.trackUrl("ups", "1Z999AA10123456784").includes("tracknum=1Z999AA10123456784"));
});
t("text -> state: English", () => {
  const c = (txt, st) => assert.strictEqual(M.stateFromText(txt), st, txt);
  c("Delivered, left at front door", "delivered");
  c("Out for delivery", "out_for_delivery");
  c("Customs fee of NIS 35 is due", "action_pay");
  c("Awaiting payment", "action_pay");
  c("Ready for pickup at locker", "action_pickup");
  c("Attempt made to deliver, place closed, notice left", "action_pickup");
  c("Shipment exception: address problem", "exception_stuck");
  c("Returned to sender", "exception_stuck");
  c("Customs clearance in progress", "customs");
  c("Released from customs", "in_transit");
  c("Departed facility", "in_transit");
  c("Label created", "shipped");
  c("You're getting a shipment", "shipped");
  c("Thank you for your order", "ordered");
  assert.strictEqual(M.stateFromText("hello world"), null);
  assert.strictEqual(M.stateFromText(""), null);
});
t("text -> state: Hebrew", () => {
  assert.strictEqual(M.stateFromText("ממתין לתשלום מכס"), "action_pay");
  assert.strictEqual(M.stateFromText("החבילה מוכנה לאיסוף בנקודת איסוף"), "action_pickup");
  assert.strictEqual(M.stateFromText("החבילה נמסרה"), "delivered");
  assert.strictEqual(M.stateFromText("יצא לחלוקה"), "out_for_delivery");
  assert.strictEqual(M.stateFromText("הוחזר לשולח"), "exception_stuck");
});
t("17TRACK status mapping", () => {
  assert.strictEqual(M.stateFromTrack17("Delivered"), "delivered");
  assert.strictEqual(M.stateFromTrack17("InTransit", "InTransit_CustomsProcessing"), "customs");
  assert.strictEqual(M.stateFromTrack17("InTransit", "", "Customs fee due"), "action_pay");
  assert.strictEqual(M.stateFromTrack17("AvailableForPickup"), "action_pickup");
  assert.strictEqual(M.stateFromTrack17("DeliveryFailure", "", "notice left, ready for pickup"), "action_pickup");
  assert.strictEqual(M.stateFromTrack17("DeliveryFailure", "DeliveryFailure_InvalidAddress"), "exception_stuck");
  assert.strictEqual(M.stateFromTrack17("Exception"), "exception_stuck");
  assert.strictEqual(M.stateFromTrack17("InfoReceived"), "shipped");
  assert.strictEqual(M.stateFromTrack17("NotFound"), null);
});
t("state list and precedence order", () => {
  assert.deepStrictEqual(M.STATES, ["ordered", "shipped", "in_transit", "customs", "action_pay", "action_pickup", "out_for_delivery", "delivered", "exception_stuck"]);
  assert.ok(M.rankState("delivered") > M.rankState("in_transit"));
  assert.ok(M.rankState("exception_stuck") > M.rankState("delivered"));
});
t("stuck rule: no change for N days while in transit", () => {
  const s = M.makeShipment({ numbers: ["1Z999AA10123456784"], state: "in_transit", stateAt: NOW - 6 * DAY, lastChangeAt: NOW - 6 * DAY }, NOW);
  assert.strictEqual(M.effectiveState(s, NOW), "exception_stuck");
  assert.strictEqual(M.isStuck(s, NOW), true);
  assert.strictEqual(M.effectiveState(s, NOW, 10), "in_transit");
  const f = M.makeShipment({ numbers: ["1Z999AA10123456784"], state: "in_transit", stateAt: NOW - 2 * DAY, lastChangeAt: NOW - 2 * DAY }, NOW);
  assert.strictEqual(M.effectiveState(f, NOW), "in_transit");
  assert.strictEqual(M.actionText(s, NOW), "No update for 6 days");
  const o = M.makeShipment({ numbers: [], state: "ordered", stateAt: NOW - 30 * DAY, lastChangeAt: NOW - 30 * DAY }, NOW);
  assert.strictEqual(M.effectiveState(o, NOW), "ordered");   // an order with no parcel yet is not "stuck"
  const p = M.makeShipment({ numbers: ["RR123456789IL"], state: "action_pickup", stateAt: NOW - 30 * DAY, lastChangeAt: NOW - 30 * DAY }, NOW);
  assert.strictEqual(M.effectiveState(p, NOW), "action_pickup");
});
t("applyEvents sets last event, state, eta, and a new event resets the stuck clock", () => {
  const s = M.makeShipment({ numbers: ["RR123456789IL"], state: "shipped", stateAt: NOW - 8 * DAY, lastChangeAt: NOW - 8 * DAY }, NOW);
  const ch = M.applyEvents(s, [{ at: NOW - 3600000, text: "Arrived at post office", place: "Haifa" }, { at: NOW - 3 * DAY, text: "Departed facility", place: "Tel Aviv" }], NOW, { eta: "2026-10-09" });
  assert.strictEqual(ch, true);
  assert.strictEqual(s.lastEvent.place, "Haifa");
  assert.strictEqual(s.eta.slice(0, 10), "2026-10-09");
  assert.notStrictEqual(M.effectiveState(s, NOW), "exception_stuck");
  assert.strictEqual(s.polledOk, true);
  assert.strictEqual(M.applyEvents(s, [{ at: NOW - 3600000, text: "Arrived at post office", place: "Haifa" }], NOW + 1000), false);   // same event: no change
});
t("an older event never overrides a newer state", () => {
  const s = M.makeShipment({ numbers: ["RR123456789IL"], state: "action_pickup", stateAt: NOW - DAY, lastChangeAt: NOW - DAY }, NOW);
  M.applyEvents(s, [{ at: NOW - 5 * DAY, text: "Departed facility" }], NOW);
  assert.strictEqual(s.state, "action_pickup");
});
t("delivered archives, history is kept, a newer non-final event reopens", () => {
  const s = M.makeShipment({ numbers: ["RR123456789IL"], state: "in_transit", stateAt: NOW - 3 * DAY }, NOW);
  M.applyEvents(s, [{ at: NOW - 1000, text: "Delivered to recipient" }], NOW);
  assert.strictEqual(s.state, "delivered");
  assert.strictEqual(s.archived, true);
  assert.ok(s.history.some((h) => h.state === "delivered") && s.history.some((h) => h.state === "in_transit"));
  M.setState(s, "in_transit", NOW + 1000, "re-sent", NOW + 1000);
  assert.strictEqual(s.archived, false);
});
t("mark picked up archives and keeps history; bring back works", () => {
  const s = M.makeShipment({ numbers: ["RR123456789IL"], state: "action_pickup", stateAt: NOW - DAY }, NOW);
  M.markPickedUp(s, NOW);
  assert.strictEqual(s.archived, true); assert.strictEqual(s.pickedUp, true); assert.strictEqual(s.state, "delivered");
  assert.ok(s.history.length >= 2);
  M.unarchiveShipment(s, NOW);
  assert.strictEqual(s.archived, false); assert.strictEqual(s.pickedUp, false);
});
t("merge: same number from two mails is one parcel; same mail twice is a no-op", () => {
  const list = [];
  const a = M.mergeCandidate(list, { numbers: [{ no: "878247853307", carrier: "fedex" }], state: "shipped", msgId: "m1", at: NOW - 2 * DAY, merchant: "Cartoni SPA" }, NOW);
  assert.strictEqual(a.created, true);
  const b = M.mergeCandidate(list, { numbers: [{ no: "8782 4785 3307" }], state: "in_transit", msgId: "m2", at: NOW - DAY }, NOW);
  assert.strictEqual(b.created, false); assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].state, "in_transit");
  const c = M.mergeCandidate(list, { numbers: [{ no: "878247853307" }], state: "in_transit", msgId: "m2", at: NOW - DAY }, NOW);
  assert.strictEqual(c.changed, false);
});
t("merge: two numbers for one parcel (AliExpress LP + Israel Post RR) via order id", () => {
  const list = [];
  M.mergeCandidate(list, { numbers: [{ no: "LP00123456789012345678" }], orderId: "8123456789", merchant: "AliExpress", state: "shipped", msgId: "a", at: NOW - 10 * DAY }, NOW);
  const r = M.mergeCandidate(list, { numbers: [{ no: "RR123456789IL" }], orderId: "8123456789", merchant: "AliExpress", state: "action_pickup", msgId: "b", at: NOW - DAY }, NOW);
  assert.strictEqual(list.length, 1); assert.strictEqual(r.created, false);
  assert.deepStrictEqual(list[0].numbers.map((x) => x.no), ["LP00123456789012345678", "RR123456789IL"]);
  assert.strictEqual(list[0].carrier, "israelpost");
  assert.strictEqual(list[0].state, "action_pickup");
});
t("merge: a number found later joins an order-only placeholder", () => {
  const list = [];
  M.mergeCandidate(list, { numbers: [], orderId: "111-2222222-3333333", merchant: "Amazon", state: "ordered", msgId: "a", at: NOW - 5 * DAY }, NOW);
  M.mergeCandidate(list, { numbers: [{ no: "TBA123456789012" }], orderId: "111-2222222-3333333", merchant: "Amazon", state: "shipped", msgId: "b", at: NOW - DAY }, NOW);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].numbers[0].carrier, "amazon");
  assert.strictEqual(list[0].state, "shipped");
});
t("mail older than known state does not rewrite it", () => {
  const list = [];
  M.mergeCandidate(list, { numbers: [{ no: "RR123456789IL" }], state: "action_pickup", msgId: "a", at: NOW - DAY }, NOW);
  M.mergeCandidate(list, { numbers: [{ no: "RR123456789IL" }], state: "shipped", msgId: "b", at: NOW - 6 * DAY }, NOW);
  assert.strictEqual(list[0].state, "action_pickup");
});
t("mergeShipments joins two existing parcels", () => {
  const a = M.makeShipment({ numbers: ["LP00123456789012345678"], state: "shipped", stateAt: NOW - 5 * DAY }, NOW);
  const b = M.makeShipment({ numbers: ["RR123456789IL"], state: "in_transit", stateAt: NOW - DAY, merchant: "AliExpress" }, NOW);
  M.mergeShipments(a, b, NOW);
  assert.strictEqual(a.numbers.length, 2); assert.strictEqual(a.state, "in_transit"); assert.strictEqual(a.merchant, "AliExpress");
});
t("grouping: needs action first, archive separate, sorted", () => {
  const list = M.demoShipments(NOW);
  const g = M.groupShipments(list, NOW);
  const ids = (x) => x.map((s) => s.id);
  assert.deepStrictEqual(ids(g.archive), ["d6"]);
  assert.ok(ids(g.needs).includes("d2") && ids(g.needs).includes("d3") && ids(g.needs).includes("d4"));   // pickup, pay, stuck (9 days old)
  assert.ok(ids(g.transit).includes("d1") && ids(g.transit).includes("d5"));
  assert.strictEqual(g.needs[0].id, "d2");   // pickup deadline in 6 days sorts before undated
});
t("action text", () => {
  const p = M.makeShipment({ numbers: ["RR123456789IL"], state: "action_pickup", pickupBy: new Date(NOW + 3 * DAY).toISOString(), stateAt: NOW }, NOW);
  assert.strictEqual(M.actionText(p, NOW), "Pick up within 3 days");
  const y = M.makeShipment({ numbers: ["1Z999AA10123456784"], state: "action_pay", amountDue: "NIS 148", stateAt: NOW }, NOW);
  assert.strictEqual(M.actionText(y, NOW), "Pay NIS 148 to release it");
});
t("sweep drops old archived parcels only", () => {
  const old = M.makeShipment({ numbers: ["RR123456789IL"], archived: true, archivedAt: NOW - 400 * DAY }, NOW);
  const recent = M.makeShipment({ numbers: ["RR123456780IL"], archived: true, archivedAt: NOW - 10 * DAY }, NOW);
  const live = M.makeShipment({ numbers: ["RR123456781IL"] }, NOW);
  const list = [old, recent, live];
  assert.strictEqual(M.sweep(list, NOW), true);
  assert.strictEqual(list.length, 2);
});
t("makeShipment cleans junk and caps text", () => {
  const s = M.makeShipment({ numbers: [null, 5, "  ", { no: "rr1" }], title: "a\u0000b" + "z".repeat(500), state: "bogus", eta: "nonsense" }, NOW);
  assert.ok(s.title.length <= 120 && !/\u0000/.test(s.title));
  assert.strictEqual(s.state, "ordered"); assert.strictEqual(s.eta, null);
});
console.log(`shipments: ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);

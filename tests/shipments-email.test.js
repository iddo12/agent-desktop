// node tests/shipments-email.test.js - My Daily Shipments mail extraction (src/daily/shipments-email.js), realistic sample mails.
"use strict";
const assert = require("assert");
const E = require("../src/daily/shipments-email");
const M = require("../src/daily/shipments-model");
const NOW = Date.parse("2026-10-06T10:00:00Z");
let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.stack.split("\n").slice(0, 3).join("\n  ")); } }
const one = (mail) => { const r = E.extractShipments(mail, NOW); assert.strictEqual(r.length, 1, "expected one candidate for: " + mail.subject); return r[0]; };

const FEDEX = {
  from: "FedEx <TrackingUpdates@fedex.com>", subject: "You're getting a shipment 878247853307", date: "2026-10-05T07:12:00Z", messageId: "<fx1@fedex.com>",
  body: "Cartoni SPA, Rome IT is sending you a package.\n\nTracking number: 878247853307\nFrom: Cartoni SPA, Rome, IT\nDelivering to: Haifa, IL\nScheduled delivery: Thursday, 8 Oct 2026\n\nTrack your shipment: https://www.fedex.com/fedextrack/?trknbr=878247853307\n",
};
t("FedEx 'You're getting a shipment 878247853307' from Cartoni SPA, Rome", () => {
  const c = one(FEDEX);
  assert.deepStrictEqual(c.numbers, [{ no: "878247853307", carrier: "fedex" }]);
  assert.strictEqual(c.carrier, "fedex");
  assert.strictEqual(c.state, "shipped");
  assert.ok(/Cartoni SPA/.test(c.from) && /Rome/.test(c.from));
  assert.strictEqual(c.merchant, "Cartoni SPA");
  assert.strictEqual(c.to, "Haifa");
  assert.strictEqual(c.eta.slice(0, 10), "2026-10-08");
});
t("numeric dates read as day/month unless the first part exceeds 12", () => {
  assert.strictEqual(E.parseDateText("10/08/2026").slice(0, 10), "2026-08-10");
  assert.strictEqual(E.parseDateText("08/10/2026").slice(0, 10), "2026-10-08");
  assert.strictEqual(E.parseDateText("10/25/2026").slice(0, 10), "2026-10-25");
  assert.strictEqual(E.parseDateText("2026-10-12").slice(0, 10), "2026-10-12");
  assert.strictEqual(E.parseDateText("Monday, October 12").slice(0, 10), "2026-10-12");
  assert.strictEqual(E.parseDateText("12 Oct 2026").slice(0, 10), "2026-10-12");
  assert.strictEqual(E.parseDateText("Oct 12, 2026").slice(0, 10), "2026-10-12");
  assert.strictEqual(E.parseDateText("no date here"), null);
});
t("FedEx subject only (feed without a body) still yields the number", () => {
  const c = one({ from: "FedEx <TrackingUpdates@fedex.com>", subject: "You're getting a shipment 878247853307", date: "2026-10-05T07:12:00Z", messageId: "<fx2@fedex.com>" });
  assert.strictEqual(c.numbers[0].no, "878247853307");
  assert.strictEqual(c.numbers[0].carrier, "fedex");
});
t("UPS update with link and label", () => {
  const c = one({ from: "UPS <pkginfo@ups.com>", subject: "UPS Update: Package Scheduled for Delivery Tomorrow", date: "2026-10-05T09:00:00Z", messageId: "<u1>",
    body: "Your package is scheduled for delivery tomorrow, 07 Oct 2026.\nTracking Number: 1Z999AA10123456784\nhttps://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784\nShip From: B&H Photo Video\n" });
  assert.strictEqual(c.numbers.length, 1);
  assert.strictEqual(c.numbers[0].carrier, "ups");
  assert.strictEqual(c.eta.slice(0, 10), "2026-10-07");
});
t("DHL Express 10-digit number needs the DHL sender", () => {
  const c = one({ from: "DHL Express <noreply@dhl.com>", subject: "DHL Express - your shipment is on its way", date: "2026-10-04T08:00:00Z", messageId: "<d1>", body: "Waybill number 1234567890. Estimated delivery date: 9 October 2026." });
  assert.deepStrictEqual(c.numbers, [{ no: "1234567890", carrier: "dhl" }]);
  assert.strictEqual(c.state, "in_transit");
  assert.strictEqual(c.eta.slice(0, 10), "2026-10-09");
  assert.deepStrictEqual(E.extractShipments({ from: "Bob <bob@example.com>", subject: "lunch 1234567890", body: "call me on 1234567890", date: "2026-10-04T08:00:00Z" }, NOW), []);
});
t("Amazon shipped mail: TBA number and order id", () => {
  const c = one({ from: "Amazon.com <shipment-tracking@amazon.com>", subject: "Shipped: your order of Lens cleaning kit", date: "2026-10-03T12:00:00Z", messageId: "<a1>",
    body: "Your package has shipped.\nOrder #111-2233445-6677889\nCarrier: Amazon Logistics. Tracking ID: TBA123456789012\nArriving Monday, Oct 12\n" });
  assert.strictEqual(c.numbers[0].no, "TBA123456789012");
  assert.strictEqual(c.numbers[0].carrier, "amazon");
  assert.strictEqual(c.orderId, "111-2233445-6677889");
  assert.strictEqual(c.merchant, "Amazon");
  assert.strictEqual(c.state, "shipped");
  assert.strictEqual(c.eta.slice(0, 10), "2026-10-12");
});
t("Amazon order id is never taken as a tracking number", () => {
  const r = E.extractShipments({ from: "Amazon <order-update@amazon.com>", subject: "Your Amazon.com order #111-2233445-6677889", date: "2026-10-03T12:00:00Z", messageId: "<a2>", body: "Thank you for your order. Order 111-2233445-6677889 placed." }, NOW);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0].numbers, []);
  assert.strictEqual(r[0].state, "ordered");
  assert.strictEqual(r[0].orderId, "111-2233445-6677889");
});
t("AliExpress shipped: Cainiao LP number and order id", () => {
  const c = one({ from: "AliExpress <transaction@notice.aliexpress.com>", subject: "Your order has been shipped", date: "2026-09-28T05:00:00Z", messageId: "<ae1>",
    body: "Order ID: 8123456789012345\nTracking number: LP00123456789012345678\nEstimated delivery time: 2026-10-20\n" });
  assert.strictEqual(c.numbers[0].carrier, "cainiao");
  assert.strictEqual(c.merchant, "AliExpress");
  assert.strictEqual(c.orderId, "8123456789012345");
  assert.strictEqual(c.eta.slice(0, 10), "2026-10-20");
});
t("Israel Post: customs fee mail -> action_pay with amount", () => {
  const c = one({ from: "Israel Post <noreply@israelpost.co.il>", subject: "Customs fee payment required for RR123456789CN", date: "2026-10-05T11:00:00Z", messageId: "<ip1>",
    body: "A customs fee of NIS 35.50 is due before your item RR123456789CN can be delivered. Pay online." });
  assert.strictEqual(c.numbers[0].no, "RR123456789CN");
  assert.strictEqual(c.numbers[0].carrier, "israelpost");
  assert.strictEqual(c.state, "action_pay");
  assert.ok(/35\.50/.test(c.amountDue), c.amountDue);
});
t("Israel Post: ready for pickup with deadline", () => {
  const c = one({ from: "דואר ישראל <info@postil.com>", subject: "החבילה שלך מוכנה לאיסוף", date: "2026-10-05T11:00:00Z", messageId: "<ip2>",
    body: "החבילה RR987654321IL מוכנה לאיסוף בסניף. Please pick up your parcel by 15/10/2026 from the branch." });
  assert.strictEqual(c.numbers[0].no, "RR987654321IL");
  assert.strictEqual(c.state, "action_pickup");
  assert.strictEqual(c.pickupBy.slice(0, 10), "2026-10-15");
});
t("iHerb: sender sets the merchant, labelled number, carrier from body/link", () => {
  const c = one({ from: "iHerb <orders@iherb.com>", subject: "Your iHerb order has shipped", date: "2026-10-02T10:00:00Z", messageId: "<ih1>",
    body: "Order number: 123456789\nTracking number: 9876543210\nCarrier: DHL Express\nhttps://www.dhl.com/global-en/home/tracking.html?tracking-id=9876543210" });
  assert.strictEqual(c.merchant, "iHerb");
  assert.deepStrictEqual(c.numbers[0], { no: "9876543210", carrier: "dhl" });
  assert.strictEqual(c.orderId, "123456789");
});
t("delivered mail", () => {
  const c = one({ from: "UPS <pkginfo@ups.com>", subject: "UPS Update: Package Delivered", date: "2026-10-05T15:00:00Z", messageId: "<u2>", body: "Delivered. Tracking Number: 1Z999AA10123456784" });
  assert.strictEqual(c.state, "delivered");
});
t("delay mail -> exception", () => {
  const c = one({ from: "Amazon <shipment-tracking@amazon.com>", subject: "Your package has been delayed", date: "2026-10-05T15:00:00Z", messageId: "<a3>", body: "Tracking ID: TBA123456789012" });
  assert.strictEqual(c.state, "exception_stuck");
});
t("random mail from people is ignored", () => {
  assert.deepStrictEqual(E.extractShipments({ from: "Dana <dana@gmail.com>", subject: "Dinner on Friday?", body: "Are you free? My phone is 0521234567.", date: "2026-10-05T15:00:00Z" }, NOW), []);
  assert.deepStrictEqual(E.extractShipments(null, NOW), []);
  assert.deepStrictEqual(E.extractShipments({ from: "x", subject: 5 }, NOW), []);
  assert.strictEqual(E.looksLikeShipment({ from: "Dana <dana@gmail.com>", subject: "Dinner?" }), false);
  assert.strictEqual(E.looksLikeShipment({ from: "FedEx <TrackingUpdates@fedex.com>", subject: "anything" }), true);
});
t("html bodies are stripped, hostile text is not executed or kept as markup", () => {
  const c = one({ from: "FedEx <TrackingUpdates@fedex.com>", subject: "FedEx shipment 878247853307", date: "2026-10-05T07:12:00Z", messageId: "<h1>",
    body: "<html><style>.x{}</style><body><script>alert(1)</script><p>From: <b>Acme &amp; Co, Berlin</b></p><p>Tracking number 878247853307</p></body></html>" });
  assert.strictEqual(c.numbers[0].no, "878247853307");
  assert.ok(!/[<>]/.test(c.from), c.from);
});
t("end to end: two mails, one parcel", () => {
  const list = [];
  for (const m of [FEDEX, { from: "FedEx <TrackingUpdates@fedex.com>", subject: "FedEx: your shipment is out for delivery 878247853307", date: "2026-10-07T06:00:00Z", messageId: "<fx3>", body: "Tracking number 878247853307" }]) {
    for (const c of E.extractShipments(m, NOW)) M.mergeCandidate(list, c, NOW);
  }
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].state, "out_for_delivery");
  assert.strictEqual(list[0].msgIds.length, 2);
});
t("parseAddInput: number, link, sms, dictation, junk", () => {
  assert.deepStrictEqual(E.parseAddInput("RR123456789IL").numbers, [{ no: "RR123456789IL", carrier: "israelpost" }]);
  assert.strictEqual(E.parseAddInput("https://www.ups.com/track?tracknum=1Z999AA10123456784").numbers[0].carrier, "ups");
  const d = E.parseAddInput("tracking 878247853307 FedEx from Cartoni");
  assert.strictEqual(d.numbers[0].carrier, "fedex"); assert.strictEqual(d.title, "Cartoni");
  assert.strictEqual(E.parseAddInput("דואר ישראל: חבילה RR987654321IL ממתינה לך").numbers[0].no, "RR987654321IL");
  assert.strictEqual(E.parseAddInput("hello").ok, false);
  assert.strictEqual(E.parseAddInput("").ok, false);
});
console.log(`shipments-email: ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);

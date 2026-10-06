// node tests/calendar.test.js - My Daily calendar sources (src/daily/calendar.js), with a fake fetcher (no network)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { create, validateUrl } = require("../src/daily/calendar");
let fails = 0, n = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }
const GOOD = "https://calendar.google.com/calendar/ical/iddo%40example.com/private-abcdef1234567890/basic.ics";
const ICS = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261008T070000Z\r\nDTEND:20261008T080000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
const NOW = Date.UTC(2026, 9, 6);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cal-"));

t("validateUrl accepts the secret iCal link and webcal://, refuses anything else", () => {
  assert.ok(validateUrl(GOOD).url);
  assert.ok(validateUrl(GOOD.replace("https://", "webcal://")).url);
  for (const bad of ["", "not a url", "http://calendar.google.com/calendar/ical/a/private-x/basic.ics", "https://evil.example.com/calendar/ical/a/private-x/basic.ics", "https://calendar.google.com/calendar/ical/a/private-x/other.ics", "https://calendar.google.com.evil.com/calendar/ical/a/private-x/basic.ics"])
    assert.ok(validateUrl(bad).error, bad);
});
t("add -> load shows events and never exposes the link; file holds it", async () => {
  const dir = tmp(); let hits = 0;
  const c = create({ dataDir: dir, fetcher: async () => { hits++; return ICS; } });
  assert.deepStrictEqual(c.add("Iddo", GOOD), { ok: true });
  const r = await c.load(NOW);
  assert.strictEqual(r.connected, true);
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].title, "Dentist");
  assert.ok(!JSON.stringify(r.sources).includes("private-abcdef"));
  assert.strictEqual(r.sources[0].tail, "7890".slice(0, 0) + GOOD.replace(/\/basic\.ics$/, "").slice(-4));
  await c.load(NOW);   // fresh: no second fetch
  assert.strictEqual(hits, 1);
  assert.ok(fs.readFileSync(path.join(dir, "calendar-sources.json"), "utf8").includes("private-abcdef"));
});
t("a failing fetch is reported without the link; duplicates and the 7th source are refused", async () => {
  const c = create({ dataDir: tmp(), fetcher: async (u) => { throw new Error("boom " + u); } });
  c.add("A", GOOD);
  const r = await c.load(NOW);
  assert.strictEqual(r.connected, false);
  assert.ok(r.sources[0].error && !r.sources[0].error.includes("private-abcdef"));
  assert.strictEqual(c.add("again", GOOD).ok, false);
  for (let i = 0; i < 5; i++) assert.ok(c.add("n" + i, GOOD.replace("abcdef", "x" + i)).ok);
  assert.strictEqual(c.add("seventh", GOOD.replace("abcdef", "zz")).ok, false);
});
t("remove works and a non-calendar answer is an error", async () => {
  const c = create({ dataDir: tmp(), fetcher: async () => "<html>login</html>" });
  c.add("A", GOOD);
  assert.strictEqual((await c.load(NOW)).connected, false);
  assert.deepStrictEqual(c.remove(0), { ok: true });
  assert.strictEqual(c.list().length, 0);
  assert.strictEqual(c.remove(3).ok, false);
});
(async () => {
  for (const [name, fn] of tests) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
  console.log(fails ? `${fails} of ${n} FAILED` : `calendar: ${n} tests passed`);
  process.exit(fails ? 1 : 0);
})();

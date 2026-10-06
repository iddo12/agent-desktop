// node tests/ics.test.js - My Daily iCalendar reader (src/daily/ics.js)
const assert = require("assert");
const { parseIcs } = require("../src/daily/ics");

let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
const wrap = (...ev) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...ev.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const FROM = Date.UTC(2026, 9, 1), TO = Date.UTC(2026, 11, 31);
const utc = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h || 0, mi || 0);

t("single UTC event, text unescaped and folded line joined", () => {
  const r = parseIcs(wrap(["UID:a1", "DTSTART:20261008T070000Z", "DTEND:20261008T080000Z", "SUMMARY:Dentist\\, Dr. Levi", "LOCATION:Tel Aviv\\nRoom 2", "DESCRIPTION:long te", " xt"]), FROM, TO);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "Dentist, Dr. Levi");
  assert.strictEqual(r[0].location, "Tel Aviv Room 2");
  assert.strictEqual(r[0].start, utc(2026, 10, 8, 7));
  assert.strictEqual(r[0].end, utc(2026, 10, 8, 8));
});
t("TZID Asia/Jerusalem converts to UTC (UTC+3 in October 2026, UTC+2 in December)", () => {
  const r = parseIcs(wrap(["UID:b", "DTSTART;TZID=Asia/Jerusalem:20261008T100000", "DTEND;TZID=Asia/Jerusalem:20261008T110000", "SUMMARY:Call"], ["UID:c", "DTSTART;TZID=Asia/Jerusalem:20261215T100000", "DTEND;TZID=Asia/Jerusalem:20261215T110000", "SUMMARY:Winter"]), FROM, TO);
  const by = Object.fromEntries(r.map((e) => [e.title, e]));
  assert.strictEqual(by.Call.start, utc(2026, 10, 8, 7));
  assert.strictEqual(by.Winter.start, utc(2026, 12, 15, 8));
});
t("all-day event (VALUE=DATE)", () => {
  const r = parseIcs(wrap(["UID:d", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261011", "SUMMARY:Holiday"]), FROM, TO);
  assert.strictEqual(r[0].allDay, true);
  assert.strictEqual(r[0].start, new Date(2026, 9, 10).getTime());
});
t("weekly RRULE with BYDAY, COUNT and EXDATE", () => {
  const r = parseIcs(wrap(["UID:e", "DTSTART:20261005T090000Z", "DTEND:20261005T093000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6", "EXDATE:20261007T090000Z", "SUMMARY:Standup"]), FROM, TO);
  assert.deepStrictEqual(r.map((e) => e.start), [utc(2026, 10, 5, 9), utc(2026, 10, 12, 9), utc(2026, 10, 14, 9), utc(2026, 10, 19, 9), utc(2026, 10, 21, 9)]);
});
t("RECURRENCE-ID override moves one occurrence", () => {
  const r = parseIcs(wrap(["UID:f", "DTSTART:20261006T100000Z", "DTEND:20261006T110000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Daily"], ["UID:f", "RECURRENCE-ID:20261007T100000Z", "DTSTART:20261007T150000Z", "DTEND:20261007T160000Z", "SUMMARY:Daily (moved)"]), FROM, TO);
  assert.deepStrictEqual(r.map((e) => [e.title, e.start]), [["Daily", utc(2026, 10, 6, 10)], ["Daily (moved)", utc(2026, 10, 7, 15)], ["Daily", utc(2026, 10, 8, 10)]]);
});
t("monthly on the 31st skips short months; yearly birthday; UNTIL stops", () => {
  const m = parseIcs(wrap(["UID:g", "DTSTART:20261031T100000Z", "DTEND:20261031T110000Z", "RRULE:FREQ=MONTHLY", "SUMMARY:M"]), FROM, Date.UTC(2027, 3, 1));
  assert.deepStrictEqual(m.map((e) => new Date(e.start).getUTCMonth() + 1), [10, 12, 1, 3]);
  const y = parseIcs(wrap(["UID:h", "DTSTART;VALUE=DATE:20200715", "RRULE:FREQ=YEARLY", "SUMMARY:Birthday"]), Date.UTC(2026, 5, 1), Date.UTC(2027, 7, 31));
  assert.strictEqual(y.length, 2);
  const u = parseIcs(wrap(["UID:i", "DTSTART:20261001T100000Z", "DTEND:20261001T110000Z", "RRULE:FREQ=DAILY;UNTIL=20261003T235959Z", "SUMMARY:U"]), FROM, TO);
  assert.strictEqual(u.length, 3);
});
t("cancelled events, events outside the window, junk lines and missing DTSTART are skipped", () => {
  const r = parseIcs(wrap(["UID:j", "DTSTART:20261008T070000Z", "STATUS:CANCELLED", "SUMMARY:X"], ["UID:k", "DTSTART:20250101T070000Z", "DTEND:20250101T080000Z", "SUMMARY:Old"], ["UID:l", "SUMMARY:NoStart"], ["garbage line", "UID:m", "DTSTART:notadate", "SUMMARY:Bad"]), FROM, TO);
  assert.strictEqual(r.length, 0);
});
t("event window: a long recurring series stays bounded", () => {
  const r = parseIcs(wrap(["UID:n", "DTSTART:20100101T000000Z", "DTEND:20100101T003000Z", "RRULE:FREQ=DAILY", "SUMMARY:Every day"]), FROM, TO);
  assert.strictEqual(r.length, 92);
});
console.log(fails ? `${fails} of ${n} FAILED` : `ics: ${n} tests passed`);
process.exit(fails ? 1 : 0);

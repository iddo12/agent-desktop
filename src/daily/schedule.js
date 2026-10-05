// My Daily - Schedule and Emails pure helpers. Written to load both in Node (tests, main process) and as a plain
// <script> in the renderer (window.dailySchedule), so there is one copy of the logic. No fs, no electron, no clock.
(function (root) {
  "use strict";
  const pad2 = (n) => String(n).padStart(2, "0");
  // Days-waiting colour: 1-2 d grey, 3-4 d amber, 5+ d red (the number is always shown next to it).
  function waitClass(days) { return days >= 5 ? "d5" : days >= 3 ? "d3" : "d0"; }
  // ---------------------------------------------------------------- Schedule tab
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // Weeks (Sunday first) covering a month: [[{key, day, month, year, inMonth}]...] (5 or 6 rows)
  function monthGrid(year, month /* 1-12 */) {
    const first = new Date(year, month - 1, 1);
    const weeks = [];
    for (let w = 0; w < 6; w++) {
      const row = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(year, month - 1, 1 - first.getDay() + w * 7 + i);
        row.push({ key: dayKey(d), day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear(), inMonth: d.getMonth() === month - 1 });
      }
      if (w >= 4 && !row.some((c) => c.inMonth)) break;
      weeks.push(row);
    }
    return weeks;
  }
  // Entries of a date range as a Map dayKey -> [{kind:"appt"|"date", title, start?, end?, cal, id, ...}]; dates first, then by start.
  // Birthdays and dates (dates.json, showOnSchedule !== false) repeat yearly unless one-off.
  function scheduleEntries(events, dates, fromMs, toMs) {
    const map = new Map();
    const push = (k, e) => { if (!map.has(k)) map.set(k, []); map.get(k).push(e); };
    for (const e of events || []) if (e && e.start >= fromMs && e.start < toMs) push(dayKey(new Date(e.start)), Object.assign({ kind: "appt" }, e));
    const y0 = new Date(fromMs).getFullYear(), y1 = new Date(toMs - 1).getFullYear();
    for (const x of dates || []) {
      if (!x || x.showOnSchedule === false || !(x.month >= 1 && x.month <= 12 && x.day >= 1 && x.day <= 31)) continue;
      const years = x.repeat === false && x.year ? [x.year] : Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
      for (const y of years) {
        const d = new Date(y, x.month - 1, x.day);
        if (d.getMonth() !== x.month - 1 || d.getTime() < fromMs || d.getTime() >= toMs) continue;
        push(dayKey(d), { kind: "date", id: x.id, title: x.title, cal: "bday", dateKind: x.kind });
      }
    }
    for (const l of map.values()) l.sort((a, b) => (a.kind === b.kind ? (a.start || 0) - (b.start || 0) : a.kind === "date" ? -1 : 1));
    return map;
  }
  // Six consecutive months from (year, month): [{year, month, count, days: {day: "appt"|"date"|"both"}}]
  function sixMonths(events, dates, year, month) {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(year, month - 1 + i, 1);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const map = scheduleEntries(events, dates, new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime());
      const days = {};
      let count = 0;
      for (const [k, list] of map) {
        count += list.length;
        const a = list.some((e) => e.kind === "appt"), b = list.some((e) => e.kind === "date");
        days[Number(k.slice(8))] = a && b ? "both" : a ? "appt" : "date";
      }
      out.push({ year: y, month: m, count, days });
    }
    return out;
  }
  
  const api = { waitClass, dayKey, monthGrid, scheduleEntries, sixMonths };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.dailySchedule = api;
})(typeof window !== "undefined" ? window : globalThis);

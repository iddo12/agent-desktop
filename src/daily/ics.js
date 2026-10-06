// My Daily - minimal iCalendar (.ics) reader for Google Calendar's "secret address in iCal format".
// Pure functions, no I/O. parseIcs(text, fromMs, toMs) -> [{ id, title, start, end, allDay, location, source: "ics", uid }]
// Handles: line unfolding, TEXT unescaping, UTC / TZID / floating / all-day times, RRULE (DAILY WEEKLY MONTHLY YEARLY with
// INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY), EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED. Anything it cannot read is skipped.
const MAX_INSTANCES = 1500;      // per recurring event inside the window
const MAX_EVENTS = 4000;         // total returned
const BUDGET_MS = 300;           // overall time budget for all recurrence expansion in one parse
const DAY = 86400000;
const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function unfold(text) { return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n"); }
function unescapeText(s) { return String(s || "").replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); }
function parseLine(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const left = line.slice(0, i), value = line.slice(i + 1);
  const parts = left.split(";");
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) { const k = p.indexOf("="); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ""); }
  return { name, params, value };
}

// offset (ms) of a zone at a UTC instant: local - utc
const dtfCache = new Map();
function zoneOffset(tz, utcMs) {
  let f = dtfCache.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (e) { f = null; }
    dtfCache.set(tz, f);
  }
  if (!f) return null;
  const p = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}
// wall-clock parts in `tz` -> UTC ms (two-pass, correct across DST except the nonexistent hour)
function wallToUtc(y, mo, d, h, mi, s, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi, s).getTime();   // floating = this PC's zone
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === "UTC") return guess;
  const o1 = zoneOffset(tz, guess);
  if (o1 == null) return new Date(y, mo - 1, d, h, mi, s).getTime();
  let t = guess - o1;
  const o2 = zoneOffset(tz, t);
  if (o2 != null && o2 !== o1) t = guess - o2;
  return t;
}
// -> { ms, allDay, tz, wall:[y,mo,d,h,mi,s] } or null
function parseTime(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (m[4] === undefined) return { ms: new Date(y, mo - 1, d).getTime(), allDay: true, tz: null, wall: [y, mo, d, 0, 0, 0] };
  const h = +m[4], mi = +m[5], s = +(m[6] || 0);
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, tz: "UTC", wall: [y, mo, d, h, mi, s] };
  const tz = params && params.TZID ? params.TZID : null;
  return { ms: wallToUtc(y, mo, d, h, mi, s, tz), allDay: false, tz, wall: [y, mo, d, h, mi, s] };
}
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const n = (x) => +x || 0;
  return (m[1] === "-" ? -1 : 1) * (n(m[2]) * 7 * DAY + n(m[3]) * DAY + n(m[4]) * 3600000 + n(m[5]) * 60000 + n(m[6]) * 1000);
}
function parseRrule(v) {
  const r = {};
  for (const part of String(v).split(";")) { const k = part.indexOf("="); if (k > 0) r[part.slice(0, k).toUpperCase()] = part.slice(k + 1); }
  if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(r.FREQ || "")) return null;
  r.INTERVAL = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  r.COUNT = r.COUNT ? parseInt(r.COUNT, 10) : null;
  r.BYDAY = r.BYDAY ? r.BYDAY.split(",").map((x) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim())).filter(Boolean).map((m) => ({ n: m[1] ? parseInt(m[1], 10) : 0, d: DOW.indexOf(m[2]) })) : null;
  r.BYMONTHDAY = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map((x) => parseInt(x, 10)).filter(Number.isFinite) : null;
  return r;
}

// Occurrence start times (wall-clock based, so DST keeps the same local hour) as UTC ms, inside [fromMs, toMs].
function expand(ev, rule, fromMs, toMs, deadline) {
  const out = [];
  const [y0, mo0, d0, h, mi, s] = ev.start.wall;
  const tz = ev.start.allDay ? null : ev.start.tz;
  const mk = (y, mo, d) => (ev.start.allDay ? new Date(y, mo - 1, d).getTime() : wallToUtc(y, mo, d, h, mi, s, tz));
  const until = rule.UNTIL ? (parseTime(rule.UNTIL, {}) || {}).ms : null;
  const dur = ev.end - ev.start.ms;
  let count = 0, guard = 0;
  // returns false when expansion should stop
  const push = (y, mo, d, strict) => {
    if ((guard & 63) === 0 && Date.now() > deadline) return false;   // overall budget spent: stop expanding
    const n = new Date(Date.UTC(y, mo - 1, d));
    if (strict && n.getUTCDate() !== d) return true;   // e.g. the 31st in a 30-day month: skipped
    const t = mk(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
    if (t < ev.start.ms) return true;
    if (until != null && t > until + (ev.start.allDay ? DAY : 0)) return false;
    count++;
    if (rule.COUNT && count > rule.COUNT) return false;
    if (t > toMs) return false;
    if (t + dur >= fromMs) out.push(t);
    return out.length < MAX_INSTANCES;
  };
  if (rule.FREQ === "DAILY") {
    for (let i = 0; guard++ < 20000; i += rule.INTERVAL) if (!push(y0, mo0, d0 + i, false)) break;
  } else if (rule.FREQ === "WEEKLY") {
    const startDow = new Date(Date.UTC(y0, mo0 - 1, d0)).getUTCDay();
    const days = (rule.BYDAY && rule.BYDAY.length ? rule.BYDAY.map((x) => x.d) : [startDow]).sort((a, b) => a - b);
    const weekStart = d0 - startDow;   // Sunday of the first week (WKST=SU assumed)
    outer: for (let w = 0; guard++ < 5000; w += rule.INTERVAL) {
      for (const dow of days) if (!push(y0, mo0, weekStart + w * 7 + dow, false)) break outer;
    }
  } else if (rule.FREQ === "MONTHLY") {
    outer2: for (let m = 0; guard++ < 2400; m += rule.INTERVAL) {
      const base = new Date(Date.UTC(y0, mo0 - 1 + m, 1));
      const Y = base.getUTCFullYear(), M = base.getUTCMonth() + 1, dim = new Date(Date.UTC(Y, M, 0)).getUTCDate();
      let ds = [];
      if (rule.BYMONTHDAY) ds = rule.BYMONTHDAY.map((x) => (x < 0 ? dim + 1 + x : x)).filter((x) => x >= 1 && x <= dim);
      else if (rule.BYDAY && rule.BYDAY.length) {
        for (const b of rule.BYDAY) {
          const all = [];
          for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(Y, M - 1, d)).getUTCDay() === b.d) all.push(d);
          if (!b.n) ds.push(...all);
          else { const x = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (x) ds.push(x); }
        }
      } else ds = d0 <= dim ? [d0] : [];
      for (const d of ds.sort((a, b) => a - b)) if (!push(Y, M, d, true)) break outer2;
    }
  } else {   // YEARLY
    for (let k = 0; guard++ < 400; k += rule.INTERVAL) if (!push(y0 + k, mo0, d0, true)) break;
  }
  return out;
}

function parseIcs(text, fromMs, toMs) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (!line) continue;
    if (line === "BEGIN:VEVENT") { cur = []; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (cur) { const p = parseLine(line); if (p) cur.push(p); }
  }
  const deadline = Date.now() + BUDGET_MS;
  const masters = [], overrides = new Map();
  for (const props of events) {
    const g = (n) => props.find((p) => p.name === n);
    const all = (n) => props.filter((p) => p.name === n);
    try {
      if (g("STATUS") && /CANCELLED/i.test(g("STATUS").value)) continue;
      const ds = g("DTSTART");
      if (!ds) continue;
      const start = parseTime(ds.value, ds.params);
      if (!start || !Number.isFinite(start.ms)) continue;
      let end = null;
      const de = g("DTEND"), du = g("DURATION");
      if (de) { const e = parseTime(de.value, de.params); end = e && Number.isFinite(e.ms) ? e.ms : null; }
      if (end == null && du) { const d = parseDuration(du.value); if (d != null) end = start.ms + d; }
      if (end == null || end < start.ms) end = start.allDay ? start.ms + DAY : start.ms;
      const uid = g("UID") ? g("UID").value : "";
      const title = unescapeText(g("SUMMARY") && g("SUMMARY").value).slice(0, 200) || "(no title)";
      const location = unescapeText(g("LOCATION") && g("LOCATION").value).slice(0, 200);
      const ev = { uid, start, end, title, location };
      const rid = g("RECURRENCE-ID");
      if (rid) { const r = parseTime(rid.value, rid.params); if (r) overrides.set(uid + "|" + r.ms, ev); continue; }
      const rr = g("RRULE");
      ev.rule = rr ? parseRrule(rr.value) : null;
      ev.exdates = new Set();
      for (const x of all("EXDATE")) for (const v of x.value.split(",")) { const t = parseTime(v, x.params); if (t) ev.exdates.add(t.ms); }
      masters.push(ev);
    } catch (e) { /* skip this event */ }
  }
  const out = [];
  const add = (ev, startMs, endMs, i) => {
    if (endMs < fromMs && startMs < fromMs) return;
    if (startMs > toMs) return;
    out.push({ id: "ics:" + (ev.uid || ev.title) + ":" + startMs + ":" + i, uid: ev.uid, title: ev.title, start: startMs, end: endMs, allDay: !!ev.start.allDay, location: ev.location, source: "ics", cal: "google" });
  };
  for (const ev of masters) {
    const dur = ev.end - ev.start.ms;
    if (!ev.rule) { add(ev, ev.start.ms, ev.end, 0); continue; }
    let i = 0;
    if (Date.now() > deadline) break;
    for (const t of expand(ev, ev.rule, fromMs, toMs, deadline)) {
      if (ev.exdates.has(t)) continue;
      const o = overrides.get(ev.uid + "|" + t);
      if (o) add(o, o.start.ms, o.end, i++); else add(ev, t, t + dur, i++);
    }
  }
  // overrides whose master is not in the file are shown as plain events
  const have = new Set(masters.map((m) => m.uid));
  for (const [k, o] of overrides) if (!have.has(k.split("|")[0])) add(o, o.start.ms, o.end, 0);
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, MAX_EVENTS);
}

module.exports = { parseIcs, parseTime, wallToUtc };

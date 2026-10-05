// My Daily - turns a voice transcript into something storable (v1.72.0 phase 4). Pure functions, no fs, no electron,
// no clock (the caller passes `now`). Loads in Node (tests, main process) and as a plain <script> in the renderer
// (window.dailyVoiceParse). English and Hebrew; nothing here is clever on purpose: the result is always shown to
// the user for a check before anything is saved.
(function (root) {
  "use strict";
  const pad2 = (n) => String(n).padStart(2, "0");
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const HE_NUM = { "אחת": 1, "שתיים": 2, "שתים": 2, "שלוש": 3, "שלושה": 3, "ארבע": 4, "חמש": 5, "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9, "עשר": 10, "אחת עשרה": 11, "שתים עשרה": 12 };

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  // ---------------------------------------------------------------- shopping
  const LEAD = [
    /^(?:please\s+)?(?:add|put|buy|get|pick up|we need|i need|need|remember to buy|don't forget|do not forget)\s+(?:to (?:buy|get)\s+)?/i,
    /^(?:הוסף|הוסיפי|תוסיף|תוסיפי|צריך|צריכים|צריכה|לקנות|תקנה|תקני)\s+(?:לקנות\s+)?/,
  ];
  const TAIL = [/\s+(?:to|on|in)\s+(?:the|my)\s+(?:shopping\s+)?list\.?$/i, /\s+(?:לרשימה|לרשימת הקניות)\.?$/];
  // Splits on commas, new lines, "and", "plus", "also", "then" and the Hebrew comma/"ועוד". Quantities stay with their item
  // ("two apples" -> "2 apples"). Returns up to 30 unique, trimmed items.
  function splitItems(text) {
    let s = clean(text).replace(/[־]/g, "-");
    for (const re of LEAD) s = s.replace(re, "");
    for (const re of TAIL) s = s.replace(re, "");
    const parts = s.split(/\s*(?:[,;،\n]|\.\s+|\s+(?:and|plus|also|then|ועוד)\s+)\s*/i);
    const out = [], seen = new Set();
    for (let p of parts) {
      p = clean(p).replace(/[.!?]+$/, "").replace(/^(?:a|an|some|עוד)\s+(?=\S)/i, "");
      p = p.replace(/^(?:and|also|then)\s+/i, "");
      const m = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?=\S)/i.exec(p);
      if (m) p = NUM_WORDS[m[1].toLowerCase()] + " " + p.slice(m[0].length);
      p = clean(p);
      if (!p) continue;
      p = cap(p).slice(0, 200);
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
      if (out.length >= 30) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- tasks
  const TASK_LEAD = [
    /^(?:please\s+)?(?:add|create|make|new)\s+(?:a\s+|new\s+)?(?:task|todo|to-do)(?:\s+(?:to|for me to|called|named|that))?[\s:,-]*/i,
    /^(?:please\s+)?remind me to\s+/i,
    /^(?:task|todo|to-do)[\s:,-]+/i,
    /^(?:משימה|משימה חדשה|תזכיר לי|תזכירי לי)[\s:,-]*/,
  ];
  function taskTitle(text) {
    let s = clean(text);
    for (const re of TASK_LEAD) s = s.replace(re, "");
    s = clean(s).replace(/[.!]+$/, "");
    return cap(s).slice(0, 200);
  }

  // ---------------------------------------------------------------- appointments
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const SHORT_IDX = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const HE_DAYS = [["ראשון", 0], ["שני", 1], ["שלישי", 2], ["רביעי", 3], ["חמישי", 4], ["שישי", 5], ["שבת", 6]];

  const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const addDays = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
  const monthIdx = (w) => { const k = String(w).toLowerCase(); let i = MONTHS.indexOf(k); if (i < 0) i = MONTHS.findIndex((m) => m.slice(0, 3) === k.slice(0, 3) && k.length >= 3 && k.length <= 4); return i; };

  // The next date (strictly after today) that falls on weekday `dow`.
  function nextWeekday(todayMs, dow) {
    const cur = new Date(todayMs).getDay();
    let diff = (dow - cur + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(todayMs, diff);
  }

  // Returns {start, end, hasDate, hasTime, who, notes, matched[]}. start/end are ms or 0 when nothing was understood
  // (hasDate/hasTime tell which parts came from the speech); `who` is what is left of the sentence.
  function parseAppointment(text, now) {
    let s = " " + clean(text).replace(/[.!?]+(\s|$)/g, "$1") + " ";
    const today = dayStart(now);
    let date = null, hh = null, mm = 0, durMin = 0;
    const take = (re, fn) => { const m = re.exec(s); if (!m) return false; const r = fn(m); if (r === false) return false; s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); return true; };

    // duration: "for two hours", "for 30 minutes", "for an hour"
    take(/\s(?:for|למשך)\s+(?:(an?|one|two|three|four|\d+(?:\.\d+)?)\s+)?(hours?|hrs?|minutes?|mins?|שעה|שעתיים|דקות)\b/i, (m) => {
      const unit = m[2].toLowerCase();
      if (unit === "שעתיים") { durMin = 120; return true; }
      const q = m[1] ? (/^an?$/i.test(m[1]) || /^one$/i.test(m[1]) ? 1 : NUM_WORDS[m[1].toLowerCase()] || Number(m[1])) : 1;
      if (!(q > 0 && q <= 12)) return false;
      durMin = /^(h|שעה)/i.test(unit) ? Math.round(q * 60) : Math.round(q);
      return true;
    });

    // time (before dates so "14:30" is not read as a day/month)
    const setTime = (h, mi, ap) => {
      if (mi < 0 || mi > 59 || h < 0 || h > 24) return false;
      if (ap) { const pm = /^p/i.test(ap); if (h > 12 || h === 0) return false; h = (h % 12) + (pm ? 12 : 0); }
      hh = h === 24 ? 0 : h; mm = mi; return true;
    };
    const timeDone = take(/\s(?:at|@|by|around|בשעה|ב-?)?\s*(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$)/i, (m) => setTime(Number(m[1]), Number(m[2]), m[3] && m[3].replace(/\./g, "")))
      || take(/\s(?:at|@|by|around|בשעה|ב-?)\s*(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$)/i, (m) => { const h = Number(m[1]); const ap = m[2] && m[2].replace(/\./g, ""); if (!setTime(h, 0, ap)) return false; if (!ap && h >= 1 && h <= 7) hh = h + 12; return true; })
      || take(/\s(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?=\s|$)/i, (m) => setTime(Number(m[1]), 0, m[2].replace(/\./g, "")))
      || take(/\s(?:at|@|by|around)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(?:o'?clock|(a\.?m\.?|p\.?m\.?)))?(?=\s|$)/i, (m) => { const h = NUM_WORDS[m[1].toLowerCase()]; const ap = m[2] && m[2].replace(/\./g, ""); if (!setTime(h, 0, ap)) return false; if (!ap && h >= 1 && h <= 7) hh = h + 12; return true; })
      || take(/\s(?:at|@)\s+noon(?=\s|$)|\snoon(?=\s|$)/i, () => setTime(12, 0))
      || take(/\sבשעה\s+(אחת עשרה|שתים עשרה|\S+)(?=\s|$)/, (m) => { const h = HE_NUM[m[1]]; if (!h) return false; if (!setTime(h, 0)) return false; if (h >= 1 && h <= 7) hh = h + 12; return true; });
    if (!timeDone) { hh = null; mm = 0; }

    // date
    if (take(/\s(?:the\s+)?day after tomorrow(?=\s|$)|\sמחרתיים(?=\s|$)/i, () => { date = addDays(today, 2); return true; })) { /* done */ }
    else if (take(/\s(?:tomorrow|tmrw|מחר)(?=\s|$)/i, () => { date = addDays(today, 1); return true; })) { /* done */ }
    else if (take(/\s(?:today|tonight|this evening|היום|הערב)(?=\s|$)/i, (m) => { date = today; if (/tonight|evening|הערב/i.test(m[0]) && hh == null) { hh = 19; mm = 0; } return true; })) { /* done */ }
    else if (take(/\s(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?=\s|$)/i, (m) => {
      const mi = monthIdx(m[2]); const d = Number(m[1]); if (mi < 0 || d < 1 || d > 31) return false;
      let t = new Date(new Date(today).getFullYear(), mi, d).getTime(); if (t < today) t = new Date(new Date(today).getFullYear() + 1, mi, d).getTime();
      date = t; return true; })) { /* done */ }
    else if (take(/\s(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?=\s|$)/i, (m) => {
      const mi = monthIdx(m[1]); const d = Number(m[2]); if (mi < 0 || d < 1 || d > 31) return false;
      let t = new Date(new Date(today).getFullYear(), mi, d).getTime(); if (t < today) t = new Date(new Date(today).getFullYear() + 1, mi, d).getTime();
      date = t; return true; })) { /* done */ }
    else if (take(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?=\s|$)/, (m) => {
      const d = Number(m[1]), mo = Number(m[2]); if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
      let t = new Date(new Date(today).getFullYear(), mo - 1, d).getTime(); if (t < today) t = new Date(new Date(today).getFullYear() + 1, mo - 1, d).getTime();
      date = t; return true; })) { /* done */ }
    else if (take(/\s(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)(?=\s|$)/i, (m) => {
      const d = Number(m[1]); if (d < 1 || d > 31) return false;
      const base = new Date(today); let t = new Date(base.getFullYear(), base.getMonth(), d).getTime();
      if (t < today) t = new Date(base.getFullYear(), base.getMonth() + 1, d).getTime();
      date = t; return true; })) { /* done */ }
    else if (take(/\s(?:on\s+)?(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?=\s|$)/i, (m) => {
      const k = m[2].toLowerCase(); const dow = DAYS.indexOf(k) >= 0 ? DAYS.indexOf(k) : SHORT_IDX[k]; if (dow == null) return false;
      date = nextWeekday(today, dow); return true; })) { /* done */ }
    else if (take(/\s(?:ב)?יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?=\s|$)/, (m) => { const h = HE_DAYS.find((x) => x[0] === m[1]); date = nextWeekday(today, h[1]); return true; })) { /* done */ }
    else if (take(/\s(?:next week|בשבוע הבא)(?=\s|$)/i, () => { date = addDays(today, 7); return true; })) { /* done */ }
    else if (take(/\s(?:in\s+)?(?:(a|one|two|three|\d+)\s+)?(days?|weeks?)(?:\s+from now)?(?=\s|$)/i, (m) => {
      if (!/^in\s/i.test(m[0].trim()) && !/from now/i.test(m[0])) return false;
      const q = m[1] ? (/^(a|one)$/i.test(m[1]) ? 1 : NUM_WORDS[m[1].toLowerCase()] || Number(m[1])) : 1;
      date = addDays(today, /^w/i.test(m[2]) ? 7 * q : q); return true; })) { /* done */ }

    const hasDate = date != null, hasTime = hh != null;
    let start = 0, end = 0;
    if (hasDate || hasTime) {
      let d0 = hasDate ? date : today;
      if (!hasDate && hasTime && new Date(d0).setHours(hh, mm, 0, 0) < now) d0 = addDays(today, 1);   // "at 5" said after 5 pm means tomorrow
      const sd = new Date(d0);
      start = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), hasTime ? hh : 9, hasTime ? mm : 0).getTime();
      end = start + (durMin || 60) * 60000;
    }
    let who = clean(s).replace(/^(?:please\s+)?(?:set up|schedule|book|add|create|make|new)\s+(?:an?\s+)?(?:appointment|meeting|event)?\s*(?:called|named|for|with)?\s*/i, (m) => m).replace(/\s+(?:on|at|for|in|by|the)$/i, "").replace(/^(?:on|at|for|in|by)\s+/i, "");
    who = clean(who.replace(/\s{2,}/g, " ")).replace(/\s+(?:on|at|in|by)\s+(?=with\b)/i, " ").replace(/^(?:set up|schedule|book|add|create|make|new)\s+(?:an?\s+)?/i, "");
    who = cap(clean(who).replace(/\b(on|at|in|by|the)\s*$/i, "")).slice(0, 100);
    return { start, end, hasDate, hasTime, who, matched: { date: hasDate, time: hasTime, duration: durMin > 0 }, label: start ? `${new Date(start).getFullYear()}-${pad2(new Date(start).getMonth() + 1)}-${pad2(new Date(start).getDate())} ${pad2(new Date(start).getHours())}:${pad2(new Date(start).getMinutes())}` : "" };
  }

  const api = { splitItems, taskTitle, parseAppointment, nextWeekday };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.dailyVoiceParse = api;
})(typeof window !== "undefined" ? window : globalThis);

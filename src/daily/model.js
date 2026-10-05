// My Daily - pure logic (no fs, no electron), so it is unit-tested in tests/daily.test.js.
// Everything takes `now` (ms since epoch) as an argument; nothing here reads the clock.
"use strict";

const DAY = 86400000;

function ageDays(iso, now) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY));
}

// The shared task store (tasks.py) uses priority 1 high / 2 normal / 3 low; My Daily shows 1-10.
// A task may carry its own `priority10`; otherwise 1->9, 2->5, 3->2.
function priority10(t) {
  const p = Number(t && t.priority10);
  if (Number.isInteger(p) && p >= 1 && p <= 10) return p;
  return { 1: 9, 2: 5, 3: 2 }[t && t.priority] || 5;
}

// Needs you / Working / Waiting / Queued
function taskStatus(t) {
  if (t.needsIddo) return "needs";
  if (t.status === "blocked") return "waiting";
  if ((t.tags || []).includes("queued")) return "queued";
  return "working";
}
const STATUS_LABEL = { needs: "Needs you", working: "Working", waiting: "Waiting", queued: "Queued" };

// Turn the contents of every shared_reports/tasks/<agent>.json into one flat list of open tasks.
function mapTaskStores(stores, now) {
  const out = [];
  for (const s of stores || []) {
    if (!s || !Array.isArray(s.items)) continue;
    for (const it of s.items) {
      if (!it || it.status === "done") continue;
      const tags = Array.isArray(it.tags) ? it.tags : [];
      out.push({
        id: String(it.id), agent: s.agent || "?", title: String(it.title || ""), detail: it.detail || "",
        status: taskStatus(it), priority: priority10(it),
        area: tags.includes("personal") ? "Personal" : "Business",
        list: it.group || "", created: it.created || null, ageDays: ageDays(it.created, now),
      });
    }
  }
  out.sort((a, b) => b.priority - a.priority || b.ageDays - a.ageDays);
  return out;
}

function oldest(items, ageKey, ownerKey) {
  let best = null;
  for (const i of items) if (!best || i[ageKey] > best[ageKey]) best = i;
  return best ? { days: best[ageKey], owner: best[ownerKey] || "" } : null;
}

// Fixture tasks for test mode (and the empty-store fallback is "no tasks", never fixtures).
function fixtureTasks(now) {
  const d = (n) => new Date(now - n * DAY).toISOString();
  const mk = (id, agent, title, st, p, area, list, age) => ({ id, agent, title, detail: "", status: st, priority: p, area, list, created: d(age), ageDays: age });
  return [
    mk("t1", "Travel Agent", "Book flight to Berlin", "needs", 9, "Business", "LensVid trade show", 3),
    mk("t2", "Personal Assistant", "Reply to Sony PR about review unit", "working", 8, "Business", "LensVid reviews", 1),
    mk("t3", "Travel Agent", "Choose hotel near the venue", "needs", 7, "Business", "LensVid trade show", 2),
    mk("t4", "Personal Assistant", "Renew car insurance", "waiting", 6, "Personal", "Home", 5),
    mk("t5", "Editor-in-Chief", "Approve Thursday newsletter", "working", 5, "Business", "LensVid editorial", 1),
    mk("t6", "Security", "Review NAS snapshot schedule", "queued", 4, "Business", "Infrastructure", 2),
    mk("t7", "Personal Assistant", "Gift idea for Merav's mother", "working", 3, "Personal", "Family", 4),
    mk("t8", "Graphics", "Refresh channel banner", "queued", 2, "Business", "LensVid brand", 0),
  ];
}

// Placeholder provider data (mockup copy). Times are "today"; birthdays are relative to now.
function hm(now, h, m) { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime(); }
function placeholderEmails(now) {
  const t = (h, m) => hm(now, h, m);
  return {
    top: [
      { id: "e1", account: "LensVid contact", subject: "Sony: review unit shipping details", at: t(9, 12), importance: 3 },
      { id: "e2", account: "Editor", subject: "Press embargo lifts Tuesday", at: t(8, 40), importance: 3 },
      { id: "e3", account: "Zorg", subject: "Merav: dentist reschedule?", at: t(7, 55), importance: 2 },
    ],
    needAnswer: [
      { id: "n1", account: "LensVid contact", subject: "Sony: review unit shipping details", ageDays: 1, owner: "Personal Assistant" },
      { id: "n2", account: "Zorg", subject: "Accountant: missing invoice", ageDays: 6, owner: "Personal Assistant" },
      { id: "n3", account: "Editor", subject: "Guest article, can you check the draft?", ageDays: 2, owner: "Personal Assistant" },
    ],
    sentNoReply: [
      { id: "s1", account: "Zorg", subject: "Quote request for lens rental", ageDays: 5, owner: "Personal Assistant" },
      { id: "s2", account: "LensVid contact", subject: "Sponsorship follow-up", ageDays: 3, owner: "Personal Assistant" },
    ],
    peopleToWrite: [],
  };
}
function placeholderEvents(now) {
  const t = (h, m) => hm(now, h, m);
  return [
    { id: "p1", title: "Standup with Merav", start: t(9, 0), end: t(9, 30), source: "placeholder" },
    { id: "p2", title: "Dentist, Dr. Levi", start: t(11, 0), end: t(12, 0), leaveBy: "10:30", source: "placeholder" },
    { id: "p3", title: "Call: supplier", start: t(14, 0), end: t(14, 30), source: "placeholder" },
    { id: "p4", title: "Dinner with parents", start: t(20, 0), end: t(22, 0), source: "placeholder" },
  ];
}

// dates.json items: {id, title, month (1-12), day, kind: "birthday"|"date", agent?}. Next occurrence on/after today.
function nextOccurrence(item, now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  let d = new Date(today.getFullYear(), item.month - 1, item.day);
  if (d < today) d = new Date(today.getFullYear() + 1, item.month - 1, item.day);
  return { at: d.getTime(), inDays: Math.round((d.getTime() - today.getTime()) / DAY) };
}
function upcomingDates(dates, now, limit) {
  return (dates || []).filter((x) => x && x.month >= 1 && x.month <= 12 && x.day >= 1 && x.day <= 31)
    .map((x) => Object.assign({}, x, nextOccurrence(x, now)))
    .sort((a, b) => a.at - b.at).slice(0, limit || 50);
}

// Shopping: only lists/items that exist. Done items older than 1 h count as archived (the lazy move happens in P2).
function shoppingSummary(shopping, now) {
  const lists = (shopping && Array.isArray(shopping.lists)) ? shopping.lists : [];
  let oldestItem = null, open = 0;
  for (const l of lists) for (const it of l.items || []) {
    if (it.doneAt || it.archivedAt) continue;
    open++;
    const a = ageDays(it.added, now);
    if (!oldestItem || a > oldestItem.days) oldestItem = { days: a, owner: it.addedBy || "" };
  }
  return { lists: lists.length, openItems: open, oldest: oldestItem };
}

function nextEvent(events, now) {
  const upcoming = (events || []).filter((e) => (e.end || e.start) > now).sort((a, b) => a.start - b.start);
  return upcoming[0] || null;
}

function summarize(d, now) {
  const tasks = d.tasks || [];
  const needs = tasks.filter((t) => t.status === "needs");
  const em = d.emails || { needAnswer: [], sentNoReply: [], top: [] };
  const late = (em.sentNoReply || []).filter((s) => s.ageDays >= 3);
  const dates = upcomingDates(d.dates, now, 50);
  const shop = shoppingSummary(d.shopping, now);
  return {
    tasksOpen: tasks.length,
    tasksNeed: needs.length, tasksNeedOldest: oldest(needs, "ageDays", "agent"),
    tasksOldest: oldest(tasks, "ageDays", "agent"),
    emailsNeedAnswer: (em.needAnswer || []).length, emailsNeedOldest: oldest(em.needAnswer || [], "ageDays", "owner"),
    sentNoReply: late.length, sentOldest: oldest(late, "ageDays", "owner"),
    emailsAttention: (em.needAnswer || []).length + (em.sentNoReply || []).length,
    emailsTop: (em.top || []).length,
    shopLists: shop.lists, shopOldest: shop.oldest,
    datesNext: dates[0] || null, datesCount: dates.length,
    nextEvent: nextEvent(d.events, now),
  };
}

// Badge on the sidebar entry: open tasks; blue when something needs Iddo.
function badge(s) { return { count: s.tasksOpen, blue: s.tasksNeed > 0 }; }

function pad2(n) { return String(n).padStart(2, "0"); }
function clock(ms) { const d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dateLabel(ms) { const d = new Date(ms); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; }
const oldestSub = (o) => (o ? `oldest ${o.days}d${o.owner ? " · " + o.owner : ""}` : "");

// Lines of the hover digest (view 01). Each: {kind, n|time|date, text, sub, tab}. Empty rows are left out.
function buildDigest(s, now) {
  const lines = [];
  if (s.tasksNeed) lines.push({ kind: "tasks", n: s.tasksNeed, text: s.tasksNeed === 1 ? "task needs you" : "tasks need you", sub: oldestSub(s.tasksNeedOldest), tab: "tasks" });
  if (s.emailsNeedAnswer) lines.push({ kind: "emails", n: s.emailsNeedAnswer, text: s.emailsNeedAnswer === 1 ? "important email needs an answer" : "important emails need an answer", sub: oldestSub(s.emailsNeedOldest), tab: "emails" });
  if (s.sentNoReply) lines.push({ kind: "sent", n: s.sentNoReply, text: "sent emails, no reply for 3+ days", sub: oldestSub(s.sentOldest), tab: "emails" });
  if (s.nextEvent) {
    const e = s.nextEvent;
    lines.push({ kind: "event", time: clock(e.start), text: e.title, sub: "next appointment" + (e.leaveBy ? " · leave by " + e.leaveBy : ""), tab: "schedule" });
  }
  if (s.datesNext) {
    const d = s.datesNext;
    lines.push({ kind: "date", day: d.day, mon: MONTHS[d.month - 1], text: d.title, sub: (d.inDays === 0 ? "today" : d.inDays === 1 ? "tomorrow" : `in ${d.inDays} days`) + (d.agent ? " · " + d.agent : ""), tab: "dates" });
  }
  return lines;
}

const DEFAULT_SETTINGS = { shareCalendarWithMerav: true };
function cleanSettings(raw) {
  const o = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === "object") {
    if (typeof raw.shareCalendarWithMerav === "boolean") o.shareCalendarWithMerav = raw.shareCalendarWithMerav;
  }
  return o;
}

module.exports = {
  DAY, ageDays, priority10, taskStatus, STATUS_LABEL, mapTaskStores, fixtureTasks, placeholderEmails, placeholderEvents,
  nextOccurrence, upcomingDates, shoppingSummary, nextEvent, summarize, badge, buildDigest, clock, dateLabel, cleanSettings, DEFAULT_SETTINGS,
};

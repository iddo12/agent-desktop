// My Daily - pure logic (no fs, no electron), so it is unit-tested in tests/daily.test.js.
// Everything takes `now` (ms since epoch) as an argument; nothing here reads the clock.
"use strict";

const DAY = 86400000;

// One line of plain text: control characters and line breaks become spaces, runs of spaces collapse.
function oneLine(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
const SAFE_ID = /^[\w-]{1,48}$/;
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
  // My Daily writes the exact 1-10 value as a "p7" tag, because tasks.py itself only knows 1/2/3.
  for (const tag of (t && t.tags) || []) { const m = /^p(10|[1-9])$/.exec(String(tag)); if (m) return Number(m[1]); }
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
        status: taskStatus(it), priority: priority10(it), tags,
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
  const mk = (id, agent, title, st, p, area, list, age) => ({ id, agent, title, detail: "", status: st, priority: p, tags: st === "queued" ? ["queued"] : [], area, list, created: d(age), ageDays: age });
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
      { id: "e1", account: "LensVid contact", from: "Sony PR", subject: "Sony: review unit shipping details", at: t(9, 12), importance: 3 },
      { id: "e2", account: "Editor", from: "Canon comms", subject: "Press embargo lifts Tuesday", at: t(8, 40), importance: 3 },
      { id: "e3", account: "Zorg", from: "Merav", subject: "Merav: dentist reschedule?", at: t(7, 55), importance: 2 },
      { id: "e4", account: "Zorg", from: "Dan (photographer)", subject: "Lunch Monday?", at: t(7, 20), importance: 1 },
    ],
    needAnswer: [
      { id: "n1", account: "Editor", from: "Expo organiser", subject: "Trade show booth contract", ageDays: 6, owner: "Personal Assistant" },
      { id: "n2", account: "Zorg", from: "Migdal", subject: "Insurance quote, Migdal", ageDays: 4, owner: "Personal Assistant" },
      { id: "n3", account: "LensVid contact", from: "Reader", subject: "Question about the 24-70 review", ageDays: 3, owner: "Personal Assistant" },
    ],
    sentNoReply: [
      { id: "s1", account: "Zorg", to: "landlord", subject: "Lease renewal", ageDays: 5, owner: "Personal Assistant" },
      { id: "s2", account: "Zorg", to: "mechanic", subject: "Brakes quote", ageDays: 3, owner: "Personal Assistant" },
      { id: "s3", account: "Zorg", to: "bank", subject: "Transfer confirmation", ageDays: 1, owner: "Personal Assistant" },
    ],
    peopleToWrite: [
      { id: "w1", text: "Thank Dan for the Berlin intro", by: "assistant", ageDays: 3 },
      { id: "w2", text: "Answer Yossi's wedding invitation", by: "you", ageDays: 6 },
    ],
    hidden: 14,
  };
}
// day offset from today (DST-safe), at h:m
function dayAt(now, off, h, m) { const d = new Date(now); d.setDate(d.getDate() + off); d.setHours(h, m || 0, 0, 0); return d.getTime(); }
// cal = which colour the entry gets on Schedule: iddo | merav | google
function placeholderEvents(now) {
  const E = (id, off, h, m, h2, m2, title, cal, extra) => Object.assign({ id, title, start: dayAt(now, off, h, m), end: dayAt(now, off, h2, m2), source: "placeholder", cal }, extra || {});
  return [
    E("p0", -4, 10, 0, 10, 30, "Bank", "google"),
    E("p0b", -1, 20, 0, 22, 0, "Dinner with parents", "iddo"),
    E("p1", 0, 9, 0, 9, 30, "Standup with Merav", "merav"),
    E("p2", 0, 11, 0, 12, 0, "Dentist, Dr. Levi", "iddo", { leaveBy: "10:30" }),
    E("p3", 0, 14, 0, 14, 30, "Call: supplier", "iddo"),
    E("p4", 0, 20, 0, 22, 0, "Dinner with parents", "iddo"),
    E("p5", 1, 9, 0, 10, 0, "Trade show prep", "google"),
    E("p6", 2, 10, 0, 11, 0, "Dr. Cohen", "merav"),
    E("p7", 3, 7, 40, 11, 0, "Flight Berlin", "iddo"),
    E("p8", 4, 9, 0, 18, 0, "Berlin: expo", "iddo"),
    E("p9", 6, 12, 0, 13, 0, "Back from Berlin", "iddo"),
    E("p10", 15, 10, 0, 16, 0, "Studio shoot", "iddo"),
    E("p11", 21, 9, 0, 10, 0, "Review due: Sony 24-70", "iddo"),
    E("p12", 29, 10, 0, 11, 0, "Accountant", "iddo"),
    E("p13", 38, 15, 0, 16, 0, "Lens rental pickup", "google"),
    E("p14", 76, 11, 0, 12, 0, "Year-end review", "iddo"),
    E("p15", 127, 10, 0, 11, 0, "Dentist check-up", "merav"),
    E("p16", 160, 9, 0, 12, 0, "Photo expo", "google"),
  ];
}

// dates.json items: {id, title, month (1-12), day, kind: "birthday"|"date", agent?}. Next occurrence on/after today.
function nextOccurrence(item, now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  let d;
  if (item.repeat === false && item.year) d = new Date(item.year, item.month - 1, item.day); // one-off date
  else {
    d = new Date(today.getFullYear(), item.month - 1, item.day);
    if (d < today) d = new Date(today.getFullYear() + 1, item.month - 1, item.day);
  }
  return { at: d.getTime(), inDays: Math.round((d.getTime() - today.getTime()) / DAY) };
}
function upcomingDates(dates, now, limit) {
  return (dates || []).filter((x) => x && x.month >= 1 && x.month <= 12 && x.day >= 1 && x.day <= 31)
    .map((x) => Object.assign({}, x, nextOccurrence(x, now)))
    .filter((x) => x.inDays >= 0)
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
    emailsAttention: (em.needAnswer || []).length + late.length,
    emailsTop: (em.top || []).length,
    shopLists: shop.lists, shopOldest: shop.oldest,
    datesNext: dates[0] || null, datesCount: dates.length,
    nextEvent: nextEvent(d.events, now),
  };
}

// Badge on the sidebar entry: open tasks; blue when something needs you.
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

// ---------------------------------------------------------------- Tasks tab (filters, edits)
// filter: {area: "all"|"Business"|"Personal", status: "all"|needs|working|waiting|queued, list: ""|name}
function filterTasks(tasks, f) {
  f = f || {};
  return (tasks || []).filter((t) => (!f.area || f.area === "all" || t.area === f.area)
    && (!f.status || f.status === "all" || t.status === f.status)
    && (!f.list || (t.list || "(no list)") === f.list));
}
// Chips for the LISTS row: counts respect the area and status filters, biggest first.
function taskListCounts(tasks, f) {
  const base = filterTasks(tasks, Object.assign({}, f, { list: "" }));
  const m = new Map();
  for (const t of base) { const k = t.list || "(no list)"; m.set(k, (m.get(k) || 0) + 1); }
  return { total: base.length, lists: Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
}
// tasks.py arguments for a status/priority edit. `task` is a mapped task, change = {status?, priority?}.
// tasks.py has priority 1/2/3 only, so the exact 1-10 value is also kept as a "pN" tag.
function taskEditArgs(task, change) {
  // every value that comes from data is attached as --key=value, so a title/list/id that starts with "-" is never read as an option
  const a = ["--agent=" + task.agent, "--update=" + task.id];
  const tags = (task.tags || []).filter((x) => !/^p(10|[1-9])$/.test(x) && x !== "queued");
  const st = change && change.status;
  const pr = change && change.priority;
  if (!st && !pr) throw new Error("nothing to change");
  if (st) {
    if (!["needs", "working", "waiting", "queued"].includes(st)) throw new Error("unknown status");
    a.push("--status=" + (st === "waiting" ? "blocked" : "open"), "--set-needs-iddo=" + (st === "needs" ? "yes" : "no"));
    if (st === "queued") tags.push("queued");
  } else if ((task.tags || []).includes("queued")) tags.push("queued");
  if (pr) {
    const p = Number(pr);
    if (!Number.isInteger(p) || p < 1 || p > 10) throw new Error("priority must be 1-10");
    a.push("--priority=" + String(p >= 8 ? 1 : p >= 4 ? 2 : 3));
    tags.push("p" + p);
  } else if (task.priority) tags.push("p" + task.priority);
  a.push("--tags=" + tags.join(","));
  return a;
}
// New task from a voice recording (phase 4): validates, then builds the tasks.py arguments. area "Personal" adds the
// "personal" tag (that is how the Tasks tab tells areas apart); priority 1-10 is stored the same way edits do it.
function cleanNewTask(raw) {
  const r = raw || {};
  const title = oneLine(r.title, 200);
  if (!title) return { error: "A task needs a title." };
  const agent = String(r.agent == null ? "" : r.agent).trim();
  if (!agent || agent.length > 60 || /^-/.test(agent) || /[\\\/:*?"<>|]/.test(agent)) return { error: "Pick which agent owns the task." };
  const p = Number(r.priority == null ? 5 : r.priority);
  if (!Number.isInteger(p) || p < 1 || p > 10) return { error: "Priority must be 1-10." };
  const list = oneLine(r.list, 60);
  const area = r.area === "Personal" ? "Personal" : "Business";
  const tags = ["p" + p].concat(area === "Personal" ? ["personal"] : []).concat(["voice"]);
  return { task: { title, agent, priority: p, list, area, tags } };
}
function taskAddArgs(t) {
  const a = ["--agent=" + t.agent, "--add=" + t.title, "--priority=" + String(t.priority >= 8 ? 1 : t.priority >= 4 ? 2 : 3), "--tags=" + t.tags.join(",")];
  if (t.list) a.push("--group=" + t.list);
  return a;
}
// The same edit applied to a mapped task in memory (fixtures in test mode).
function applyTaskEdit(task, change) {
  const t = Object.assign({}, task);
  if (change.status) { t.status = change.status; t.tags = (t.tags || []).filter((x) => x !== "queued").concat(change.status === "queued" ? ["queued"] : []); }
  if (change.priority) t.priority = Number(change.priority);
  return t;
}

// ---------------------------------------------------------------- Shopping lists
const DONE_HOLD_MS = 3600000;          // a ticked item stays on the list for 1 hour
const ARCHIVE_KEEP_MS = 90 * DAY;      // then lives in the archive for 90 days
let idSeq = 0;
function newId(prefix) { return prefix + Date.now().toString(36) + (idSeq++ % 1296).toString(36).padStart(2, "0") + Math.random().toString(36).slice(2, 6); }
// A damaged or hand-edited shopping.json must never crash the loader: keep only well-formed lists and items
// (items without an id get a stable one from their position, so ticking them still works).
function cleanShopping(raw) {
  const out = { lists: [] };
  const lists = raw && typeof raw === "object" && Array.isArray(raw.lists) ? raw.lists : [];
  lists.forEach((l, li) => {
    if (!l || typeof l !== "object") return;
    const items = [];
    (Array.isArray(l.items) ? l.items : []).forEach((it, ii) => {
      if (!it || typeof it !== "object") return;
      const o = Object.assign({}, it);
      o.id = SAFE_ID.test(String(it.id || "")) ? String(it.id) : "fix" + li + "_" + ii;
      o.text = oneLine(it.text, 200) || "(untitled)";
      items.push(o);
    });
    out.lists.push(Object.assign({}, l, { id: SAFE_ID.test(String(l.id || "")) ? String(l.id) : "fixl" + li, name: oneLine(l.name, 60) || "List " + (li + 1), items }));
  });
  return out;
}
function findList(s, id) { return ((s && s.lists) || []).find((l) => l.id === id) || null; }
// Lazy sweep, run when the view loads (no timer): done > 1 h -> archived; archived > 90 d -> removed.
function sweepShopping(s, now) {
  let changed = false;
  for (const l of (s && s.lists) || []) {
    if (!Array.isArray(l.items)) { l.items = []; continue; }
    for (const it of l.items) {
      if (it.doneAt && !it.archivedAt && now - Date.parse(it.doneAt) >= DONE_HOLD_MS) { it.archivedAt = new Date(Date.parse(it.doneAt) + DONE_HOLD_MS).toISOString(); changed = true; }
    }
    const keep = l.items.filter((it) => !(it.archivedAt && now - Date.parse(it.archivedAt) >= ARCHIVE_KEEP_MS));
    if (keep.length !== l.items.length) { l.items = keep; changed = true; }
  }
  return changed;
}
// op: {op, listId, itemId, text, addedBy, ...}. Mutates `s`; returns {ok, reason?}.
function shoppingOp(s, op, now) {
  const iso = new Date(now).toISOString();
  if (op.op === "create-list") {
    const name = oneLine(op.name, 60);
    if (!name) return { ok: false, reason: "A list needs a name." };
    if ((s.lists || []).some((x) => x.name.toLowerCase() === name.toLowerCase())) return { ok: false, reason: "There is already a list with that name." };
    (s.lists = s.lists || []).push({ id: newId("l"), name, created: iso, items: [] });
    return { ok: true };
  }
  const l = findList(s, op.listId);
  if (!l) return { ok: false, reason: "That list no longer exists." };
  if (!Array.isArray(l.items)) l.items = [];
  if (op.op === "add") {
    const text = oneLine(op.text, 200);
    if (!text) return { ok: false, reason: "Type what to add." };
    const it = { id: newId("i"), text, added: iso, addedBy: oneLine(op.addedBy || "Me", 60) };
    for (const k of ["source", "price", "note"]) if (op[k]) it[k] = oneLine(op[k], 200);
    if (op.link && /^https:\/\//i.test(String(op.link)) && String(op.link).length <= 2048) it.link = String(op.link);   // https only
    if (op.thumb && /^[\w-]+\.png$/.test(String(op.thumb))) it.thumb = String(op.thumb);
    if (op.fromLink) it.fromLink = true;
    if (op.detailsMissing) it.detailsMissing = true;
    l.items.push(it);
    return { ok: true, item: it };
  }
  if (op.op === "add-many") {   // voice: several items at once, one write
    const texts = (Array.isArray(op.texts) ? op.texts : []).map((x) => oneLine(x, 200)).filter(Boolean).slice(0, 30);
    if (!texts.length) return { ok: false, reason: "There is nothing to add." };
    for (const text of texts) l.items.push({ id: newId("i"), text, added: iso, addedBy: oneLine(op.addedBy || "Me", 60) });
    return { ok: true, added: texts.length };
  }
  const it = l.items.find((x) => x.id === op.itemId);
  if (!it) return { ok: false, reason: "That item no longer exists." };
  if (op.op === "tick") { if (!it.doneAt) it.doneAt = iso; delete it.archivedAt; return { ok: true }; }
  if (op.op === "untick") { delete it.doneAt; delete it.archivedAt; return { ok: true }; }
  if (op.op === "bring-back") { delete it.doneAt; delete it.archivedAt; it.added = iso; return { ok: true }; }
  if (op.op === "remove") { l.items = l.items.filter((x) => x !== it); return { ok: true }; }
  return { ok: false, reason: "Unknown action." };
}
function shoppingCounts(l) {
  const items = l.items || [];
  return { open: items.filter((i) => !i.doneAt && !i.archivedAt).length, archived: items.filter((i) => i.archivedAt).length };
}
// Plain text for "Share list" / "Send to Merav" (copied to the clipboard; actual sending is not built yet).
function shoppingShareText(l) {
  const open = (l.items || []).filter((i) => !i.doneAt && !i.archivedAt);
  const lines = [`${l.name} (${open.length} item${open.length === 1 ? "" : "s"})`];
  for (const i of open) lines.push(`- ${i.text}${i.price ? " (" + i.price + ")" : ""}${i.link ? " " + i.link : ""}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- Birthdays & dates (dates.json)
// item: {id, title, month, day, year?, kind: "birthday"|"date", repeat (default true), showOnSchedule (default true), remindDays, note}
function cleanDate(raw) {
  const month = Number(raw && raw.month), day = Number(raw && raw.day), year = Number(raw && raw.year) || 0;
  const title = oneLine(raw && raw.title, 100);
  if (!title) return { error: "Give it a name or occasion." };
  if (!(Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= 31)) return { error: "Pick a valid date." };
  const repeat = raw.repeat !== false;
  if (!repeat && !(year >= 1900 && year <= 2200)) return { error: "A one-off date needs a year." };
  const out = {
    id: SAFE_ID.test(String(raw.id || "")) ? String(raw.id) : newId("d"), title, month, day, kind: raw.kind === "birthday" ? "birthday" : "date", repeat,
    showOnSchedule: raw.showOnSchedule !== false, remindDays: [0, 1, 3, 7, 14].includes(Number(raw.remindDays)) ? Number(raw.remindDays) : 3,
  };
  if (year) out.year = year;
  if (raw.note) out.note = oneLine(raw.note, 200);
  if (raw.agent) out.agent = oneLine(raw.agent, 60);
  return { item: out };
}

// ---------------------------------------------------------------- Emails tab
const IMPORTANCE_LABEL = { 3: "High", 2: "Med", 1: "Low" };
// Counts per account for the account chips: items that need attention (needs an answer + sent 3+ days with no reply).
function emailAccountCounts(em, accounts) {
  const out = {};
  for (const a of accounts || []) out[a] = 0;
  for (const x of (em && em.needAnswer) || []) out[x.account] = (out[x.account] || 0) + 1;
  for (const x of (em && em.sentNoReply) || []) if (x.ageDays >= 3) out[x.account] = (out[x.account] || 0) + 1;
  return out;
}
function filterByAccount(list, account) { return (list || []).filter((x) => !account || account === "all" || x.account === account); }

const SCH = require("./schedule");
const { waitClass, dayKey, monthGrid, scheduleEntries, sixMonths } = SCH;

// ---------------------------------------------------------------- Schedule tab
// Add-appointment form -> stored item (own store appointments.json). start/end are ms since epoch from the renderer.
function cleanAppointment(raw) {
  const r = raw || {};
  const who = oneLine(r.who, 100);
  if (!who) return { error: "Say who the appointment is with." };
  const start = Number(r.start);
  if (!Number.isFinite(start) || start < 946684800000 || start > 7258118400000) return { error: "Pick a valid date and time." };
  let end = Number(r.end);
  if (!Number.isFinite(end) || end <= start) end = start + 3600000;
  return { item: {
    id: SAFE_ID.test(String(r.id || "")) ? String(r.id) : newId("a"), title: who, who, start, end, notes: String(r.notes || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 500), contact: oneLine(r.contact, 200),
    location: oneLine(r.location, 300), shareMerav: r.shareMerav !== false, cal: "iddo", own: true,
  } };
}

module.exports = {
  waitClass, IMPORTANCE_LABEL, emailAccountCounts, filterByAccount, dayKey, monthGrid, scheduleEntries, sixMonths, cleanAppointment, dayAt,
  oneLine, cleanShopping, SAFE_ID, filterTasks, taskListCounts, taskEditArgs, applyTaskEdit, cleanNewTask, taskAddArgs,
  DONE_HOLD_MS, ARCHIVE_KEEP_MS, sweepShopping, shoppingOp, shoppingCounts, shoppingShareText, findList, cleanDate,
  DAY, ageDays, priority10, taskStatus, STATUS_LABEL, mapTaskStores, fixtureTasks, placeholderEmails, placeholderEvents,
  nextOccurrence, upcomingDates, shoppingSummary, nextEvent, summarize, badge, buildDigest, clock, dateLabel, cleanSettings, DEFAULT_SETTINGS,
};

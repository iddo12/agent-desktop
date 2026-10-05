// node tests/daily.test.js - My Daily pure logic (src/daily/model.js) and the main-process loader
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("../src/daily/model");

let fails = 0, n = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + e.message); } }
const NOW = Date.parse("2026-10-05T10:00:00");
const iso = (daysAgo) => new Date(NOW - daysAgo * M.DAY).toISOString();

t("ageDays floors whole days, never negative", () => {
  assert.strictEqual(M.ageDays(iso(3), NOW), 3);
  assert.strictEqual(M.ageDays(new Date(NOW + 1000).toISOString(), NOW), 0);
  assert.strictEqual(M.ageDays("garbage", NOW), 0);
});
t("priority10: 1/2/3 map to 9/5/2, own priority10 wins, junk -> 5", () => {
  assert.deepStrictEqual([1, 2, 3].map((p) => M.priority10({ priority: p })), [9, 5, 2]);
  assert.strictEqual(M.priority10({ priority: 3, priority10: 7 }), 7);
  assert.strictEqual(M.priority10({ priority10: 99 }), 5);
});
t("taskStatus: needsIddo beats blocked; blocked = waiting; queued tag", () => {
  assert.strictEqual(M.taskStatus({ needsIddo: true, status: "blocked" }), "needs");
  assert.strictEqual(M.taskStatus({ status: "blocked" }), "waiting");
  assert.strictEqual(M.taskStatus({ status: "open", tags: ["queued"] }), "queued");
  assert.strictEqual(M.taskStatus({ status: "open" }), "working");
});
t("mapTaskStores: skips done, sorts by priority then age, area from tag", () => {
  const stores = [
    { agent: "A", items: [{ id: "1", title: "x", status: "open", priority: 2, created: iso(1) }, { id: "2", title: "y", status: "done", priority: 1 }] },
    { agent: "B", items: [{ id: "3", title: "z", status: "open", priority: 1, needsIddo: true, tags: ["personal"], group: "Home", created: iso(4) }] },
    null, { agent: "C" },
  ];
  const r = M.mapTaskStores(stores, NOW);
  assert.deepStrictEqual(r.map((x) => x.id), ["3", "1"]);
  assert.strictEqual(r[0].area, "Personal"); assert.strictEqual(r[0].status, "needs"); assert.strictEqual(r[0].ageDays, 4); assert.strictEqual(r[0].list, "Home");
  assert.strictEqual(r[1].area, "Business");
});
t("fixtures reproduce the mockup numbers (8 open, 2 need you, oldest 3d Travel Agent)", () => {
  const data = { tasks: M.fixtureTasks(NOW), emails: M.placeholderEmails(NOW), events: M.placeholderEvents(NOW), dates: [], shopping: { lists: [] } };
  const s = M.summarize(data, NOW);
  assert.strictEqual(s.tasksOpen, 8); assert.strictEqual(s.tasksNeed, 2);
  assert.deepStrictEqual(s.tasksNeedOldest, { days: 3, owner: "Travel Agent" });
  assert.strictEqual(s.emailsNeedAnswer, 3); assert.strictEqual(s.emailsNeedOldest.days, 6);
  assert.strictEqual(s.sentNoReply, 2); assert.strictEqual(s.sentOldest.days, 5);
  assert.strictEqual(s.emailsAttention, 5);
  assert.deepStrictEqual(M.badge(s), { count: 8, blue: true });
});
t("sent-no-reply counts only 3+ days", () => {
  const s = M.summarize({ tasks: [], emails: { needAnswer: [], top: [], sentNoReply: [{ ageDays: 2 }, { ageDays: 3 }] }, events: [], dates: [], shopping: null }, NOW);
  assert.strictEqual(s.sentNoReply, 1);
});
t("badge is not blue when nothing needs Iddo", () => assert.strictEqual(M.badge({ tasksOpen: 3, tasksNeed: 0 }).blue, false));
t("nextOccurrence: this year, today, and wraps to next year", () => {
  assert.strictEqual(M.nextOccurrence({ month: 10, day: 9 }, NOW).inDays, 4);
  assert.strictEqual(M.nextOccurrence({ month: 10, day: 5 }, NOW).inDays, 0);
  assert.strictEqual(M.nextOccurrence({ month: 10, day: 4 }, NOW).inDays, 364);
});
t("upcomingDates sorted and invalid rows dropped", () => {
  const r = M.upcomingDates([{ title: "b", month: 12, day: 1 }, { title: "a", month: 10, day: 9 }, { title: "bad", month: 13, day: 1 }], NOW);
  assert.deepStrictEqual(r.map((x) => x.title), ["a", "b"]);
});
t("nextEvent skips finished events", () => {
  const e = M.placeholderEvents(NOW);
  assert.strictEqual(M.nextEvent(e, NOW).title, "Dentist, Dr. Levi");
  assert.strictEqual(M.nextEvent(e, Date.parse("2026-10-05T23:00:00")), null);
});
t("shoppingSummary ignores done and archived items", () => {
  const s = M.shoppingSummary({ lists: [{ items: [{ added: iso(6), addedBy: "PA" }, { added: iso(9), doneAt: iso(1) }, { added: iso(9), archivedAt: iso(1) }] }, { items: [] }] }, NOW);
  assert.deepStrictEqual(s, { lists: 2, openItems: 1, oldest: { days: 6, owner: "PA" } });
});
t("buildDigest: lines in mockup order with texts", () => {
  const data = { tasks: M.fixtureTasks(NOW), emails: M.placeholderEmails(NOW), events: M.placeholderEvents(NOW), dates: [{ title: "Merav's mother's birthday", month: 10, day: 9, agent: "Personal Assistant" }], shopping: { lists: [] } };
  const d = M.buildDigest(M.summarize(data, NOW), NOW);
  assert.deepStrictEqual(d.map((x) => x.kind), ["tasks", "emails", "sent", "event", "date"]);
  assert.strictEqual(d[0].text, "tasks need you"); assert.strictEqual(d[0].sub, "oldest 3d · Travel Agent");
  assert.strictEqual(d[3].time, "11:00"); assert.strictEqual(d[3].sub, "next appointment · leave by 10:30");
  assert.strictEqual(d[4].sub, "in 4 days · Personal Assistant"); assert.strictEqual(d[4].mon, "Oct");
});
t("buildDigest: empty everything gives no lines; singular wording", () => {
  assert.deepStrictEqual(M.buildDigest(M.summarize({ tasks: [], emails: null, events: [], dates: [], shopping: null }, NOW), NOW), []);
  const one = M.buildDigest({ tasksNeed: 1, tasksNeedOldest: null, emailsNeedAnswer: 1, sentNoReply: 0 }, NOW);
  assert.strictEqual(one[0].text, "task needs you"); assert.strictEqual(one[1].text, "important email needs an answer");
});
t("cleanSettings fills defaults and rejects wrong types", () => {
  assert.deepStrictEqual(M.cleanSettings(null), { shareCalendarWithMerav: true });
  assert.deepStrictEqual(M.cleanSettings({ shareCalendarWithMerav: "no" }), { shareCalendarWithMerav: true });
  assert.deepStrictEqual(M.cleanSettings({ shareCalendarWithMerav: false }), { shareCalendarWithMerav: false });
});

// ---- main-process loader: real task-store reading, atomic writes, caching (fake ipcMain)
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-test-"));
  fs.mkdirSync(path.join(root, "shared_reports", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "shared_reports", "tasks", "Security.json"), "﻿" + JSON.stringify({ agent: "Security", items: [{ id: "a", title: "T", status: "open", priority: 1, needsIddo: true, created: new Date(Date.now() - 2 * M.DAY).toISOString() }] }));
  fs.writeFileSync(path.join(root, "shared_reports", "tasks", "broken.json"), "{nope");
  const handlers = {};
  require("../src/daily/main-daily").init({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, root, testMode: false, log: () => {} });
  const r = await handlers["daily-load"](null, {});
  try {
    assert.strictEqual(r.taskSource, "store"); assert.strictEqual(r.data.tasks.length, 1);
    assert.strictEqual(r.summary.tasksNeed, 1); assert.strictEqual(r.provider.connected, false);
    assert.strictEqual(r.badge.blue, true);
    assert.strictEqual(await handlers["daily-load"](null, {}), r, "second call within 60 s is cached");
    assert.notStrictEqual(await handlers["daily-load"](null, { force: true }), r, "force reloads");
    const s = await handlers["daily-settings-set"](null, { shareCalendarWithMerav: false });
    assert(s.ok && s.settings.shareCalendarWithMerav === false);
    assert.strictEqual((await handlers["daily-load"](null, {})).settings.shareCalendarWithMerav, false, "settings persisted and cache dropped");
    assert((await handlers["daily-shopping-create-list"](null, { name: "Groceries" })).ok);
    assert(!(await handlers["daily-shopping-create-list"](null, { name: "groceries" })).ok, "duplicate name refused");
    assert(!(await handlers["daily-shopping-create-list"](null, { name: "  " })).ok);
    assert.strictEqual((await handlers["daily-load"](null, {})).summary.shopLists, 1);
    assert(!fs.readdirSync(path.join(root, "daily")).some((f) => f.endsWith(".tmp")), "no temp files left");
    n++;
  } catch (e) { fails++; console.error("FAIL main-daily\n  " + e.message); }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED of ${n}` : `daily ok (${n} tests)`);
  process.exit(fails ? 1 : 0);
})();

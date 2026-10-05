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

// ---- Phase 2: tasks tab logic
const L = require("../src/daily/linkmeta");
t("priority10 reads the pN tag written by an edit", () => {
  assert.strictEqual(M.priority10({ priority: 2, tags: ["x", "p7"] }), 7);
  assert.strictEqual(M.priority10({ priority: 2, tags: ["p11"] }), 5);
});
t("filterTasks + taskListCounts follow area and status; lists sorted by count", () => {
  const ts = M.fixtureTasks(NOW);
  assert.strictEqual(M.filterTasks(ts, { area: "Personal" }).length, 2);
  assert.strictEqual(M.filterTasks(ts, { status: "needs", list: "LensVid trade show" }).length, 2);
  const lc = M.taskListCounts(ts, { area: "Business" });
  assert.strictEqual(lc.total, 6); assert.deepStrictEqual(lc.lists[0], { name: "LensVid trade show", count: 2 });
  assert.strictEqual(M.taskListCounts(ts, { status: "queued" }).total, 2);
});
t("taskEditArgs: status and priority map onto tasks.py flags and keep the exact 1-10 as a tag", () => {
  const task = { agent: "Security", id: "a1", tags: ["personal", "queued", "p3"], priority: 3 };
  assert.deepStrictEqual(M.taskEditArgs(task, { status: "waiting", priority: 9 }),
    ["--agent", "Security", "--update", "a1", "--status", "blocked", "--set-needs-iddo", "no", "--priority", "1", "--tags", "personal,p9"]);
  assert.deepStrictEqual(M.taskEditArgs(task, { status: "needs" }).slice(4, 8), ["--status", "open", "--set-needs-iddo", "yes"]);
  assert(M.taskEditArgs(task, { status: "queued" }).pop().includes("queued"));
  assert(M.taskEditArgs(task, { priority: 5 }).pop().includes("queued"), "queued tag kept when only priority changes");
  assert.throws(() => M.taskEditArgs(task, { priority: 11 })); assert.throws(() => M.taskEditArgs(task, {})); assert.throws(() => M.taskEditArgs(task, { status: "x" }));
});
// ---- shopping
t("shopping: add, tick, undo, lazy archive after 1 h, purge after 90 d, bring back", () => {
  const s = { lists: [] };
  assert(M.shoppingOp(s, { op: "create-list", name: "Groceries" }, NOW).ok);
  assert(!M.shoppingOp(s, { op: "create-list", name: "groceries" }, NOW).ok);
  const id = s.lists[0].id;
  const a = M.shoppingOp(s, { op: "add", listId: id, text: " Milk ", addedBy: "Iddo" }, NOW);
  assert.strictEqual(a.item.text, "Milk"); assert(!M.shoppingOp(s, { op: "add", listId: id, text: " " }, NOW).ok);
  M.shoppingOp(s, { op: "tick", listId: id, itemId: a.item.id }, NOW);
  assert.strictEqual(M.sweepShopping(s, NOW + 59 * 60000), false, "still on the list at 59 min");
  assert.strictEqual(M.shoppingCounts(s.lists[0]).open, 0);
  M.shoppingOp(s, { op: "untick", listId: id, itemId: a.item.id }, NOW + 1000);
  M.shoppingOp(s, { op: "tick", listId: id, itemId: a.item.id }, NOW + 1000);
  assert.strictEqual(M.sweepShopping(s, NOW + 1000 + M.DONE_HOLD_MS), true);
  assert(s.lists[0].items[0].archivedAt); assert.strictEqual(M.shoppingCounts(s.lists[0]).archived, 1);
  assert.strictEqual(M.sweepShopping(s, NOW + 89 * M.DAY), false);
  M.shoppingOp(s, { op: "bring-back", listId: id, itemId: a.item.id }, NOW + 89 * M.DAY);
  const it = s.lists[0].items[0]; assert(!it.doneAt && !it.archivedAt);
  M.shoppingOp(s, { op: "tick", listId: id, itemId: it.id }, NOW); M.sweepShopping(s, NOW + 2 * M.DONE_HOLD_MS);
  assert.strictEqual(M.sweepShopping(s, NOW + 92 * M.DAY), true); assert.strictEqual(s.lists[0].items.length, 0, "archive kept 90 days then dropped");
});
t("shoppingShareText is plain text with open items only", () => {
  const txt = M.shoppingShareText({ name: "Groceries", items: [{ text: "Milk" }, { text: "Eggs", doneAt: "x" }, { text: "Cage", price: "$64.00", link: "https://bhphotovideo.com/x" }] });
  assert.strictEqual(txt, "Groceries (2 items)\n- Milk\n- Cage ($64.00) https://bhphotovideo.com/x");
});
t("cleanDate validates; one-off needs a year and past one-offs leave the upcoming list", () => {
  assert(M.cleanDate({ title: "", month: 3, day: 1 }).error); assert(M.cleanDate({ title: "x", month: 13, day: 1 }).error);
  assert(M.cleanDate({ title: "x", month: 3, day: 1, repeat: false }).error);
  const c = M.cleanDate({ title: "Yossi", month: 3, day: 22, remindDays: 9 }).item;
  assert.strictEqual(c.repeat, true); assert.strictEqual(c.remindDays, 3); assert.strictEqual(c.kind, "date");
  assert.strictEqual(M.upcomingDates([{ title: "old", month: 1, day: 1, year: 2020, repeat: false }, { title: "soon", month: 12, day: 1, year: 2026, repeat: false }], NOW).length, 1);
});
// ---- link metadata (saved-page style fixtures) and SSRF guards
t("isBlockedIp covers private, loopback, link-local, CGNAT, ULA and mapped addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) assert(L.isBlockedIp(ip), ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) assert(!L.isBlockedIp(ip), ip);
});
t("checkUrl: https only, no credentials, no private hosts", () => {
  for (const u of ["http://example.com/a", "ftp://x.com", "https://localhost/a", "https://127.0.0.1/", "https://[::1]/", "https://u:p@example.com/", "https://printer.local/", "nonsense", "file:///c:/x"]) assert(!L.checkUrl(u).ok, u);
  assert(L.checkUrl("https://www.bhphotovideo.com/c/product/1").ok);
});
t("parseProduct: JSON-LD product with offers, relative image, price formatting", () => {
  const html = `<html><head><title>ignored</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"SmallRig &amp; cage for Sony A7 IV","image":["/img/cage.jpg"],"offers":{"@type":"Offer","price":"64","priceCurrency":"USD"}}]}</script></head></html>`;
  const r = L.parseProduct(html, "https://www.bhphotovideo.com/c/p/1");
  assert.deepStrictEqual(r, { found: true, title: "SmallRig & cage for Sony A7 IV", image: "https://www.bhphotovideo.com/img/cage.jpg", price: "$64.00" });
});
t("parseProduct: og/product meta fallback, then regex price; markup in titles is stripped", () => {
  const html = `<head><meta property="og:title" content="Anker 65W &lt;b&gt;USB-C&lt;/b&gt; charger"><meta property="og:image" content="https://m.media.com/a.jpg"><meta property="product:price:amount" content="1,299.50"><meta property="product:price:currency" content="ILS"></head>`;
  const r = L.parseProduct(html, "https://www.amazon.com/dp/1");
  assert.strictEqual(r.title, "Anker 65W USB-C charger"); assert.strictEqual(r.price, "₪1299.50"); assert.strictEqual(r.image, "https://m.media.com/a.jpg");
  assert.strictEqual(L.parseProduct(`<title>Shop</title><div class="p"> $19.99 </div>`, "https://x.com/").price, "$19.99");
});
t("parseProduct: captcha pages and garbage are 'not found', never throw; http images dropped", () => {
  assert.strictEqual(L.parseProduct("<title>Robot Check</title>", "https://amazon.com/").found, false);
  assert.strictEqual(L.parseProduct("", "https://x.com/").found, false);
  assert.strictEqual(L.parseProduct(`<meta property="og:title" content="T"><meta property="og:image" content="http://x.com/a.jpg">`, "https://x.com/").image, "");
  assert.strictEqual(L.parseProduct(`<script type="application/ld+json">{bad json</script><title>T</title>`, "https://x.com/").title, "T");
});
t("sourceTag names known stores and falls back to the domain", () => {
  assert.strictEqual(L.sourceTag("www.amazon.com"), "Amazon"); assert.strictEqual(L.sourceTag("www.bhphotovideo.com"), "B&H");
  assert.strictEqual(L.sourceTag("shop.aliexpress.com"), "AliExpress"); assert.strictEqual(L.sourceTag("www.mystore.co.il"), "mystore.co.il");
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
    // ---- Phase 2 handlers (fake fetch / fake tasks.py / fake thumbnail)
    {
      const ran = [];
      const h2 = {};
      const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "daily-test2-"));
      require("../src/daily/main-daily").init({
        ipcMain: { handle: (c, f) => { h2[c] = f; } }, root: root2, testMode: false, log: () => {},
        runPython: async (args) => { ran.push(args); return "ok"; },
        fetchProduct: async (u) => (/blocked/.test(u) ? { found: false, title: "", image: "", price: "", source: "AliExpress", link: u, reason: "The site answered 403." }
          : /private/.test(u) ? { rejected: true, reason: "That address is private." }
          : { found: true, title: "SmallRig cage", image: "https://img.example.com/c.jpg", price: "$64.00", source: "B&H", link: u }),
        makeThumb: async (url, id, dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id + ".png"), Buffer.from("89504e47", "hex")); return id + ".png"; },
      });
      await h2["daily-shopping-create-list"](null, { name: "Studio" });
      const lid = (await h2["daily-load"](null, { force: true })).data.shopping.lists[0].id;
      assert((await h2["daily-shopping"](null, { op: "add", listId: lid, text: "Tape", addedBy: "Iddo" })).ok);
      const lk = await h2["daily-shopping"](null, { op: "add-link", listId: lid, url: "https://www.bhphotovideo.com/x" });
      assert(lk.ok && !lk.detailsMissing);
      const bl = await h2["daily-shopping"](null, { op: "add-link", listId: lid, url: "https://aliexpress.com/blocked" });
      assert(bl.ok && bl.detailsMissing, "blocked site still adds the item");
      assert(!(await h2["daily-shopping"](null, { op: "add-link", listId: lid, url: "https://private/x" })).ok, "SSRF-rejected link is refused");
      const items = (await h2["daily-load"](null, { force: true })).data.shopping.lists[0].items;
      assert.strictEqual(items.length, 3); assert.strictEqual(items[1].text, "SmallRig cage"); assert(items[1].thumb && items[1].fromLink);
      assert.strictEqual(items[2].text, "Link from AliExpress"); assert(items[2].detailsMissing);
      const th = await h2["daily-thumbs"](null, [items[1].thumb, "../../etc/passwd", "nope.png"]);
      assert.deepStrictEqual(Object.keys(th), [items[1].thumb]); assert(th[items[1].thumb].startsWith("data:image/png;base64,"));
      assert((await h2["daily-shopping"](null, { op: "tick", listId: lid, itemId: items[0].id })).ok);
      const sh = await h2["daily-shopping"](null, { op: "share", listId: lid });
      assert(sh.ok && sh.text.startsWith("Studio (2 items)") && !sh.text.includes("Tape"));
      await h2["daily-shopping"](null, { op: "remove", listId: lid, itemId: items[1].id });
      await new Promise((r) => setTimeout(r, 100));
      assert(!fs.existsSync(path.join(root2, "daily", "thumbs", items[1].thumb)), "thumb removed with the item");
      // task edit goes through tasks.py
      fs.mkdirSync(path.join(root2, "shared_reports", "tasks"), { recursive: true });
      fs.writeFileSync(path.join(root2, "shared_reports", "tasks", "Security.json"), JSON.stringify({ agent: "Security", items: [{ id: "a", title: "T", status: "open", priority: 2, created: new Date().toISOString() }] }));
      assert((await h2["daily-task-edit"](null, { agent: "Security", id: "a", status: "waiting", priority: 6 })).ok);
      assert.deepStrictEqual(ran[0], ["--agent", "Security", "--update", "a", "--status", "blocked", "--set-needs-iddo", "no", "--priority", "2", "--tags", "p6"]);
      assert(!(await h2["daily-task-edit"](null, { agent: "Security", id: "zzz", status: "needs" })).ok);
      assert(!(await h2["daily-task-edit"](null, { agent: "Security", id: "a", priority: 99 })).ok);
      // dates
      assert((await h2["daily-dates-save"](null, { title: "Yossi", month: 3, day: 22, kind: "birthday" })).ok);
      assert(!(await h2["daily-dates-save"](null, { title: "", month: 3, day: 22 })).ok);
      let dd = (await h2["daily-load"](null, { force: true })).data.dates; assert.strictEqual(dd.length, 1);
      await h2["daily-dates-save"](null, Object.assign({}, dd[0], { title: "Yossi B" }));
      dd = (await h2["daily-load"](null, { force: true })).data.dates; assert.strictEqual(dd.length, 1); assert.strictEqual(dd[0].title, "Yossi B");
      await h2["daily-dates-delete"](null, { id: dd[0].id });
      assert.strictEqual((await h2["daily-load"](null, { force: true })).data.dates.length, 0);
      fs.rmSync(root2, { recursive: true, force: true });
    }
  } catch (e) { fails++; console.error("FAIL main-daily\n  " + e.message); }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED of ${n}` : `daily ok (${n} tests)`);
  process.exit(fails ? 1 : 0);
})();

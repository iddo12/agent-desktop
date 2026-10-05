// node tests/daily-hardening.test.js - My Daily phase 5: IPC sender check, input validation, SSRF guards, tasks.py
// argument safety, damaged/huge stores, atomic writes, big lists. No network, no Electron.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("../src/daily/model");
const L = require("../src/daily/linkmeta");
const D = require("../src/daily/main-daily");

let fails = 0, n = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
const NOW = Date.parse("2026-10-05T10:00:00");
const WIN = { webContents: { id: 1, mainFrame: { id: "main" } } };
const OWN = { sender: WIN.webContents, senderFrame: WIN.webContents.mainFrame };

function boot(opts) {
  const h = {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-hard-"));
  const ran = [];
  D.init(Object.assign({
    ipcMain: { handle: (c, f) => { h[c] = f; } }, getMainWindow: () => WIN, root, testMode: false, log: () => {},
    runPython: async (args) => { ran.push(args); return "ok"; },
  }, opts || {}));
  return { h, root, ran, daily: path.join(root, "daily") };
}

// ---------------------------------------------------------------- IPC sender
t("every daily-* channel refuses another window, another frame, a missing event and a missing main window", async () => {
  const b = boot();
  const channels = Object.keys(b.h);
  assert(channels.length >= 12, "channels registered: " + channels.length);
  for (const c of channels) {
    for (const ev of [null, {}, { sender: { id: 2 } }, { sender: WIN.webContents, senderFrame: { id: "iframe" } }]) {
      const r = await b.h[c](ev, {});
      assert(r && r.ok === false && r.reason === "Not allowed.", c + " accepted a foreign caller");
    }
  }
  assert.strictEqual((await b.h["daily-settings-set"](OWN, { shareCalendarWithMerav: false })).ok, true, "the main window still works");
  const h2 = {};
  D.init({ ipcMain: { handle: (c, f) => { h2[c] = f; } }, root: b.root, testMode: false, log: () => {} });   // no getMainWindow: fail closed
  assert.strictEqual((await h2["daily-load"](OWN, {})).ok, false);
  const h3 = {};
  D.init({ ipcMain: { handle: (c, f) => { h3[c] = f; } }, getMainWindow: () => ({ isDestroyed: () => true, webContents: WIN.webContents }), root: b.root, testMode: false, log: () => {} });
  assert.strictEqual((await h3["daily-load"](OWN, {})).ok, false, "destroyed window");
  fs.rmSync(b.root, { recursive: true, force: true });
});
t("oversized or unserialisable arguments are refused before any handler runs", async () => {
  const b = boot();
  const big = { name: "x".repeat(300000) };
  assert.strictEqual((await b.h["daily-shopping-create-list"](OWN, big)).ok, false);
  const cyc = {}; cyc.self = cyc;
  assert.strictEqual((await b.h["daily-shopping"](OWN, cyc)).ok, false);
  assert(!fs.existsSync(b.daily), "nothing written");
  fs.rmSync(b.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- input validation
t("IPC inputs: wrong types never throw or write junk; ids, paths and sizes are checked", async () => {
  const b = boot();
  const junk = [undefined, null, 0, 7, "str", [], [1, 2], true, { op: {} }, { op: "add", listId: {}, text: [] }, { id: {}, agent: [] }];
  for (const c of Object.keys(b.h)) for (const j of junk) { const r = await b.h[c](OWN, j); assert(r && typeof r === "object", c + " returned " + r); }
  assert((await b.h["daily-shopping-create-list"](OWN, { name: "Groceries" })).ok);
  const lid = (await b.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].id;
  // path traversal through thumb names, in reads and in the stored item
  fs.mkdirSync(path.join(b.daily, "thumbs"), { recursive: true });
  fs.writeFileSync(path.join(b.daily, "secret.png"), "x");
  const th = await b.h["daily-thumbs"](OWN, ["../secret.png", "..\\secret.png", "a/b.png", "C:\\x.png", "x.png\0.png", {}, 5, null]);
  assert.deepStrictEqual(th, {});
  const add = await b.h["daily-shopping"](OWN, { op: "add", listId: lid, text: "Milk", thumb: "../../x.png", link: "javascript:alert(1)", addedBy: "Iddo" });
  const it = (await b.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].items[0];
  assert(add.ok && !it.thumb && !it.link, "unsafe thumb and non-https link are dropped");
  const add2 = await b.h["daily-shopping"](OWN, { op: "add", listId: lid, text: "Line one\nline two\u0000", link: "https://a.example/x" });
  assert(add2.ok);
  const items = (await b.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].items;
  assert.strictEqual(items[1].text, "Line one line two"); assert.strictEqual(items[1].link, "https://a.example/x");
  assert(!(await b.h["daily-shopping"](OWN, { op: "add-link", listId: lid, url: "https://example.com/" + "a".repeat(3000) })).ok, "long url refused");
  assert(!(await b.h["daily-shopping"](OWN, { op: "nope", listId: lid, itemId: "x" })).ok);
  // add-many is capped at 30 items
  const many = await b.h["daily-shopping"](OWN, { op: "add-many", listId: lid, texts: Array.from({ length: 80 }, (_, i) => "x" + i) });
  assert(many.ok);
  assert.strictEqual((await b.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].items.length, 32, "only 30 of 80 were added");
  // dates / appointments: ids are made safe, sizes capped
  assert(M.cleanDate({ id: "../../evil", title: "T", month: 1, day: 1 }).item.id !== "../../evil");
  assert(M.cleanAppointment({ id: "a/b", who: "W", start: NOW }).item.id !== "a/b");
  assert.strictEqual(M.cleanAppointment({ who: "W".repeat(500), start: NOW }).item.who.length, 100);
  assert(M.cleanAppointment({ who: "W", start: 1e18 }).error);
  // every voice-made task field is validated before it reaches tasks.py
  for (const bad of [{ title: "", agent: "A" }, { title: "T", agent: "" }, { title: "T", agent: "--x" }, { title: "T", agent: "a/b" }, { title: "T", agent: "A", priority: 11 }, { title: "T", agent: "A", priority: "x" }]) assert(!(await b.h["daily-task-add"](OWN, bad)).ok, JSON.stringify(bad));
  assert.strictEqual(b.ran.length, 0, "nothing reached tasks.py");
  fs.rmSync(b.root, { recursive: true, force: true });
});
t("the list of stores is capped (5000 appointments / dates)", async () => {
  const b = boot();
  fs.mkdirSync(b.daily, { recursive: true });
  fs.writeFileSync(path.join(b.daily, "dates.json"), JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => ({ id: "d" + i, title: "t", month: 1, day: 1 })) }));
  assert(!(await b.h["daily-dates-save"](OWN, { title: "one more", month: 2, day: 2 })).ok);
  assert((await b.h["daily-dates-save"](OWN, { id: "d7", title: "edited", month: 2, day: 2 })).ok, "editing an existing item still works");
  fs.rmSync(b.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tasks.py arguments
t("tasks.py arguments: a title, list or id starting with '-' is attached as --key=value, never a separate option", () => {
  const c = M.cleanNewTask({ title: "--delete everything", agent: "Security", priority: 5, list: "-rf", area: "Business" });
  const a = M.taskAddArgs(c.task);
  assert(a.includes("--add=--delete everything") && a.includes("--group=-rf"));
  assert(a.every((x) => /^--[a-z-]+=/.test(x)), "every argument is --key=value: " + JSON.stringify(a));
  const e = M.taskEditArgs({ agent: "Security", id: "-1", tags: [], priority: 5 }, { status: "needs" });
  assert(e.every((x) => /^--[a-z-]+=/.test(x)) && e.includes("--update=-1"));
  assert.strictEqual(M.cleanNewTask({ title: "a\nb\tc\u0007d", agent: "A" }).task.title, "a b c d");
  assert(M.cleanNewTask({ title: "x", agent: "-agent" }).error);
});
t("the real runner passes args as an array to execFile, never through a shell", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "daily", "main-daily.js"), "utf8");
  assert(/execFile\("python", \[tasksPy\]\.concat\(args\)/.test(src), "execFile with an argument array");
  assert(!/\bexec\(|shell:\s*true|spawn\(/.test(src), "no shell, no exec()");
});
t("task edits only reach tasks.py for a task that exists in the store (agent and id are looked up, not trusted)", async () => {
  const b = boot();
  fs.mkdirSync(path.join(b.root, "shared_reports", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(b.root, "shared_reports", "tasks", "Security.json"), JSON.stringify({ agent: "Security", items: [{ id: "a", title: "T", status: "open", priority: 2, created: new Date().toISOString() }] }));
  assert(!(await b.h["daily-task-edit"](OWN, { agent: "Other", id: "a", status: "needs" })).ok);
  assert(!(await b.h["daily-task-edit"](OWN, { agent: "Security", id: "--delete", status: "needs" })).ok);
  assert.strictEqual(b.ran.length, 0);
  assert((await b.h["daily-task-edit"](OWN, { agent: "Security", id: "a", status: "needs" })).ok);
  assert.strictEqual(b.ran.length, 1);
  fs.rmSync(b.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- SSRF
t("URL forms that hide a private address are refused (decimal, octal, hex, short, mapped, compat, trailing dot, ports, userinfo)", () => {
  const bad = ["https://2130706433/", "https://0x7f000001/", "https://0x7f.0.0.1/", "https://017700000001/", "https://0177.0.0.1/", "https://127.1/", "https://0/",
    "https://[::ffff:7f00:1]/", "https://[::ffff:127.0.0.1]/", "https://[::127.0.0.1]/", "https://[::]/", "https://[::1]/", "https://[fe80::1]/", "https://[fec0::1]/", "https://[fd12::1]/",
    "https://[2002:7f00:1::]/", "https://[64:ff9b::7f00:1]/", "https://[2001:0:4136:e378::]/", "https://169.254.169.254/latest/meta-data", "https://169.254.1.1/", "https://100.100.100.200/",
    "https://localhost./", "https://LOCALHOST/", "https://a.localhost/", "https://x.internal/", "https://nas.local/", "https://example.com:8443/", "https://example.com:22/", "https://example.com:80/",
    "https://user:pw@example.com/", "https://user@example.com/", "http://example.com/", "ftp://example.com/", "file:///c:/windows/win.ini", "gopher://example.com/", "javascript:alert(1)", "data:text/html,x", "", "   "];
  for (const u of bad) assert(!L.checkUrl(u).ok, "accepted " + u);
  for (const u of ["https://www.amazon.com/dp/B0", "https://www.bhphotovideo.com:443/c/p/1", "https://8.8.8.8/", "https://[2606:4700::1111]/", "https://shop.example.co.il/p?id=1"]) assert(L.checkUrl(u).ok, "refused " + u);
  assert(!L.checkUrl("https://example.com/" + "a".repeat(2100)).ok, "very long url");
});
t("isBlockedIp: private IPv4 ranges (boundaries) and special IPv6 ranges", () => {
  for (const ip of ["0.1.2.3", "10.255.255.255", "100.64.0.0", "100.127.255.255", "127.255.255.254", "169.254.0.1", "172.16.0.0", "172.31.255.255", "192.168.255.255", "192.0.0.8", "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255", "::", "::1", "::2", "::7f00:1", "fc00::1", "fdff::1", "fe80::1%eth0", "febf::1", "ff02::1", "2001:db8::1", "2002:a00:1::", "64:ff9b::a00:1", "::ffff:192.168.1.1", "::ffff:a9fe:a9fe"]) assert(L.isBlockedIp(ip), ip);
  for (const ip of ["1.1.1.1", "9.255.255.255", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.254", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) assert(!L.isBlockedIp(ip), ip);
});
t("DNS rebinding: the address is validated at connect time, a name that resolves to a private address is refused", async () => {
  const dns = require("dns");
  for (const name of ["localhost"]) {
    await new Promise((resolve) => L.safeLookup(name, {}, (err) => { assert(err, "localhost must not resolve for a fetch"); resolve(); }));
    await new Promise((resolve) => L.safeLookup(name, { all: true }, (err) => { assert(err); resolve(); }));
  }
  // a mixed answer (one public, one private record) is refused as a whole
  const orig = dns.lookup;
  dns.lookup = (host, opts, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
  try { await new Promise((resolve) => L.safeLookup("rebind.example", {}, (err) => { assert(err); resolve(); })); } finally { dns.lookup = orig; }
  dns.lookup = (host, opts, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]);
  try { await new Promise((resolve) => L.safeLookup("ok.example", {}, (err, addr) => { assert(!err && addr === "93.184.216.34"); resolve(); })); } finally { dns.lookup = orig; }
});
t("redirects: max 3, every hop re-checked (http, private, userinfo, odd port, metadata address), relative hops resolved", async () => {
  const seq = (...hops) => { const seen = []; let i = 0; return { seen, fn: async (url) => { seen.push(url.toString()); const h = hops[i++]; return h; } }; };
  const red = (loc) => ({ status: 302, headers: { location: loc }, body: Buffer.alloc(0) });
  const ok = { status: 200, headers: {}, body: Buffer.from("hi") };
  for (const loc of ["http://example.com/x", "https://127.0.0.1/", "https://169.254.169.254/latest/meta-data", "https://u:p@example.com/", "https://example.com:8443/", "https://[::1]/", "https://2130706433/", "file:///etc/passwd"]) {
    const s = seq(red(loc), ok);
    await assert.rejects(() => L.guardedGet("https://shop.example/a", "*/*", null, s.fn), loc);
    assert.strictEqual(s.seen.length, 1, "the bad hop was never requested: " + loc);
  }
  const s4 = seq(red("/b"), red("/c"), red("/d"), red("/e"), ok);
  await assert.rejects(() => L.guardedGet("https://shop.example/a", "*/*", null, s4.fn), /too many redirects/);
  const s3 = seq(red("/b"), red("https://cdn.example/c"), red("d"), ok);
  const r = await L.guardedGet("https://shop.example/a", "*/*", null, s3.fn);
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(s3.seen, ["https://shop.example/a", "https://shop.example/b", "https://cdn.example/c", "https://cdn.example/d"]);
  await assert.rejects(() => L.guardedGet("https://shop.example/a", "*/*", null, seq(red("https://x.example/" + "a".repeat(3000))).fn), /too long|redirect/);
});
t("fetchProduct never throws and reports a rejected link without touching the network", async () => {
  for (const u of ["https://127.0.0.1/", "http://x.com", "https://user@x.com", ""]) { const r = await L.fetchProduct(u); assert(r.rejected && !r.found, u); }
  const r = await L.fetchProduct("https://shop.example/a", (h, o, cb) => cb(new Error("blocked address")));
  assert(!r.found && !r.rejected && r.source === "shop.example");
});
t("web text stays text: markup in titles is stripped and the renderer never uses innerHTML or insertAdjacentHTML", () => {
  const p = L.parseProduct(`<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;Cage"><title>t</title>`, "https://x.com/");
  assert(!/[<>]/.test(p.title), p.title);
  for (const f of ["daily.js", "daily-voice.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", f), "utf8");
    assert(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), f + " builds markup from strings");
  }
});

// ---------------------------------------------------------------- damaged, missing and huge stores
t("a corrupt store is moved aside, restored from .bak with a visible notice, and never crashes the load", async () => {
  const b = boot();
  assert((await b.h["daily-shopping-create-list"](OWN, { name: "Groceries" })).ok);
  const lid = (await b.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].id;
  assert((await b.h["daily-shopping"](OWN, { op: "add", listId: lid, text: "Milk" })).ok);
  assert((await b.h["daily-shopping"](OWN, { op: "add", listId: lid, text: "Eggs" })).ok);
  const f = path.join(b.daily, "shopping.json");
  assert(fs.existsSync(f + ".bak"), "a .bak is kept on every save");
  fs.writeFileSync(f, '{"lists": [ {"id": "l1", "name": "Gro');   // torn write
  const r = await b.h["daily-load"](OWN, { force: true });
  assert(!r.error, "no crash");
  assert.strictEqual(r.data.shopping.lists[0].items.length, 1, "restored from the previous good copy (one save behind)");
  assert(r.notices.some((x) => /Shopping lists was damaged/.test(x) && /restored/.test(x)), JSON.stringify(r.notices));
  assert(fs.readdirSync(b.daily).some((x) => /^shopping\.json\.corrupt-/.test(x)), "damaged copy kept");
  assert(JSON.parse(fs.readFileSync(f, "utf8")).lists, "the live file is valid again");
  assert((await b.h["daily-notices-clear"](OWN)).ok);
  assert.deepStrictEqual((await b.h["daily-load"](OWN, { force: true })).notices, []);
  fs.rmSync(b.root, { recursive: true, force: true });
});
t("a corrupt store with no backup starts empty with a notice and keeps the damaged file; wrong shapes are repaired in memory", async () => {
  const b = boot();
  fs.mkdirSync(b.daily, { recursive: true });
  for (const [file, text] of [["dates.json", "not json at all"], ["appointments.json", "[1,2,3]"], ["settings.json", "\u0000\u0000\u0000"], ["shopping.json", '{"lists":[null,5,"x",{"id":"l9","name":7,"items":[null,{"text":"Ok"},{"id":"q","text":{"a":1}},3]}]}']]) fs.writeFileSync(path.join(b.daily, file), text);
  const r = await b.h["daily-load"](OWN, { force: true });
  assert(!r.error);
  assert.deepStrictEqual(r.data.dates, []); assert.strictEqual(r.settings.shareCalendarWithMerav, true);
  assert(r.notices.length === 3, JSON.stringify(r.notices));
  const l = r.data.shopping.lists;
  assert.strictEqual(l.length, 1); assert.strictEqual(l[0].items.length, 2); assert.strictEqual(l[0].name, "7");
  assert((await b.h["daily-shopping"](OWN, { op: "tick", listId: "l9", itemId: l[0].items[0].id })).ok, "items without an id are still usable");
  fs.rmSync(b.root, { recursive: true, force: true });
});
t("a huge store (over 25 MB) is not loaded; a locked/unreadable file is left untouched", async () => {
  const b = boot();
  fs.mkdirSync(b.daily, { recursive: true });
  const f = path.join(b.daily, "dates.json");
  fs.writeFileSync(f, '{"items":[],"pad":"' + "x".repeat(26 * 1024 * 1024) + '"}');
  const r = await b.h["daily-load"](OWN, { force: true });
  assert(!r.error && r.data.dates.length === 0 && r.notices.some((x) => /too large/.test(x)));
  assert(!fs.existsSync(f) || fs.statSync(f).size < 1024, "oversized file moved aside");
  // a directory where the file should be: unreadable, not damaged -> notice, nothing renamed or deleted
  fs.mkdirSync(path.join(b.daily, "appointments.json"));
  const r2 = await b.h["daily-load"](OWN, { force: true });
  assert(!r2.error && r2.notices.some((x) => /Appointments could not be read/.test(x)));
  assert(fs.statSync(path.join(b.daily, "appointments.json")).isDirectory());
  fs.rmSync(b.root, { recursive: true, force: true });
});
t("damaged task files are skipped with a notice; the rest still load", async () => {
  const b = boot();
  const td = path.join(b.root, "shared_reports", "tasks");
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, "Good.json"), JSON.stringify({ agent: "Good", items: [{ id: "1", title: "ok", status: "open", priority: 2, created: new Date().toISOString() }, null, { id: "2" }] }));
  fs.writeFileSync(path.join(td, "Bad.json"), "{{{");
  fs.writeFileSync(path.join(td, "Arr.json"), "[]");
  const r = await b.h["daily-load"](OWN, { force: true });
  assert(!r.error); assert.strictEqual(r.data.tasks.length, 2);
  assert(r.notices.some((x) => /2 task files could not be read/.test(x)), JSON.stringify(r.notices));
  fs.rmSync(b.root, { recursive: true, force: true });
});
t("writes are atomic: no temp file is left behind, a failed write leaves the old file intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-w-"));
  const f = path.join(dir, "x.json");
  D.writeJsonAtomic(f, { a: 1 }); D.writeJsonAtomic(f, { a: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + ".bak", "utf8")), { a: 1 });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["x.json", "x.json.bak"]);
  const cyc = {}; cyc.c = cyc;
  assert.throws(() => D.writeJsonAtomic(f, cyc));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2 });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["x.json", "x.json.bak"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
t("concurrent edits in one process never lose an item (every handler reads, changes and writes in one synchronous step)", async () => {
  const b = boot();
  await b.h["daily-shopping-create-list"](OWN, { name: "L" });
  const lid = (await b.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].id;
  await Promise.all(Array.from({ length: 60 }, (_, i) => b.h["daily-shopping"](OWN, { op: "add", listId: lid, text: "item " + i })));
  const items = (await b.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].items;
  assert.strictEqual(items.length, 60); assert.strictEqual(new Set(items.map((x) => x.id)).size, 60, "ids are unique");
  // an add-from-link that finishes while another add happened must keep both
  let release; const gate = new Promise((r) => { release = r; });
  const b2 = boot({ fetchProduct: async (u) => { await gate; return { found: true, title: "Slow product", image: "", price: "$1.00", source: "X", link: u }; } });
  await b2.h["daily-shopping-create-list"](OWN, { name: "L" });
  const lid2 = (await b2.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].id;
  const slow = b2.h["daily-shopping"](OWN, { op: "add-link", listId: lid2, url: "https://x.example/p" });
  await b2.h["daily-shopping"](OWN, { op: "add", listId: lid2, text: "Typed meanwhile" });
  release(); assert((await slow).ok);
  assert.deepStrictEqual((await b2.h["daily-load"](OWN, { force: true })).data.shopping.lists[0].items.map((x) => x.text).sort(), ["Slow product", "Typed meanwhile"]);
  fs.rmSync(b.root, { recursive: true, force: true }); fs.rmSync(b2.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- big lists stay fast
t("a 5,000-item shopping list and 2,000 tasks load, edit and sweep quickly", async () => {
  const b = boot();
  fs.mkdirSync(b.daily, { recursive: true });
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: "i" + i, text: "Item " + i, added: new Date(NOW - i * 60000).toISOString(), addedBy: "Iddo", doneAt: i % 10 === 0 ? new Date(Date.now() - 3 * 3600000).toISOString() : undefined }));
  fs.writeFileSync(path.join(b.daily, "shopping.json"), JSON.stringify({ lists: [{ id: "l1", name: "Big", items }] }));
  const td = path.join(b.root, "shared_reports", "tasks");
  fs.mkdirSync(td, { recursive: true });
  for (let a = 0; a < 4; a++) fs.writeFileSync(path.join(td, "A" + a + ".json"), JSON.stringify({ agent: "A" + a, items: Array.from({ length: 500 }, (_, i) => ({ id: "t" + i, title: "Task " + i, status: "open", priority: 1 + (i % 3), created: new Date(NOW - i * 3600000).toISOString(), tags: i % 2 ? ["personal"] : [] })) }));
  let t0 = process.hrtime.bigint();
  const r = await b.h["daily-load"](OWN, { force: true });
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(r.data.tasks.length, 2000); assert.strictEqual(r.data.shopping.lists[0].items.length, 5000);
  assert(r.data.shopping.lists[0].items.filter((x) => x.archivedAt).length === 500, "500 ticked items older than 1 h were archived lazily");
  t0 = process.hrtime.bigint();
  assert((await b.h["daily-shopping"](OWN, { op: "add", listId: "l1", text: "One more" })).ok);
  assert((await b.h["daily-shopping"](OWN, { op: "tick", listId: "l1", itemId: "i1" })).ok);
  const editMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(loadMs < 1500 && editMs < 1000, `load ${loadMs.toFixed(0)} ms, two edits ${editMs.toFixed(0)} ms`);
  console.log(`  big lists: load ${loadMs.toFixed(0)} ms (2,000 tasks + 5,000 items), add+tick ${editMs.toFixed(0)} ms`);
  fs.rmSync(b.root, { recursive: true, force: true });
});

(async () => {
  for (const { name, fn } of queue) { n++; try { await fn(); } catch (e) { fails++; console.error("FAIL " + name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e)); } }
  console.log(fails ? `${fails} FAILED of ${n}` : `daily hardening ok (${n} tests)`);
  process.exit(fails ? 1 : 0);
})();

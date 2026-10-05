// Tests for src/agentDocs.js (pure parts + scan + create() open/list with fakes).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ad = require("../src/agentDocs");

let n = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { n++; }, (e) => { console.error("FAIL " + name); throw e; }); }

(async () => {
  await t("normAgent", () => {
    assert.strictEqual(ad.normAgent("UI-UX Agent"), "uiux");
    assert.strictEqual(ad.normAgent("UI/UX"), "uiux");
    assert.strictEqual(ad.normAgent("Software Engineering Agent"), "softwareengineering");
    assert.strictEqual(ad.normAgent(""), "");
    assert.ok(ad.matchesAgent("Coo", ["COO Agent", "coo"]));
    assert.ok(!ad.matchesAgent("", ["x"]));
  });

  await t("typeOfFile", () => {
    assert.strictEqual(ad.typeOfFile("a.PDF"), "pdf");
    assert.strictEqual(ad.typeOfFile("a.jpeg"), "image");
    assert.strictEqual(ad.typeOfFile("a.py"), null);
    assert.strictEqual(ad.typeOfFile("noext"), null);
  });

  const mk = (id, title, type, mtimeMs, extra = {}) => ad.finishItem({ id, path: "C:\\x\\" + title + "." + type, title, size: 10, mtimeMs, status: "", note: "", source: "folder", ...extra });
  await t("query filter/search/paging/counts", () => {
    const now = Date.parse("2026-10-05T12:00:00");
    const items = [];
    for (let i = 0; i < 50; i++) items.push(mk("a" + i, "report" + i, "pdf", now - i * 1000));
    items.push(mk("img1", "photo", "png", now - 99999));
    const r = ad.query(items, {}, {}, now);
    assert.strictEqual(r.total, 51);
    assert.strictEqual(r.items.length, ad.PAGE_SIZE);
    assert.strictEqual(r.items[0].id, "a0"); // newest first
    assert.strictEqual(r.counts.pdf, 50); assert.strictEqual(r.counts.image, 1);
    const p2 = ad.query(items, { offset: 40 }, {}, now);
    assert.strictEqual(p2.items.length, 11);
    const f = ad.query(items, { type: "image" }, {}, now);
    assert.strictEqual(f.total, 1); assert.strictEqual(f.counts.all, 51);
    const s = ad.query(items, { search: "PHOTO" }, {}, now);
    assert.strictEqual(s.total, 1);
    const rd = ad.query(items, {}, { a0: { at: 1 } }, now);
    assert.strictEqual(rd.unread, 50); assert.strictEqual(rd.items[0].unread, false);
    const old = ad.query(items, { sort: "oldest" }, {}, now);
    assert.strictEqual(old.items[0].id, "img1");
  });

  await t("stemKey groups versions of one document", () => {
    const k = ad.stemKey;
    assert.strictEqual(k("Report_v2.pdf"), "report");
    assert.strictEqual(k("report draft5.pdf"), "report");
    assert.strictEqual(k("plan_FINAL.pdf"), "plan");
    assert.strictEqual(k("brief_2026-10-05.pdf"), "brief");
    assert.strictEqual(k("brief_v3_final.pdf"), "brief");
    assert.strictEqual(k("x (1).pdf"), "x");
    assert.notStrictEqual(k("report12.pdf"), k("report.pdf")); // digits glued to a word are not a version
    assert.strictEqual(k("v2.pdf"), "v2"); // never reduce a name to nothing
  });

  await t("query stacks versions, newest leads, images separate from docs", () => {
    const now = Date.parse("2026-10-05T12:00:00");
    const items = [mk("a1", "brief", "pdf", now - 3000), mk("a2", "brief_v2", "pdf", now - 2000), mk("a3", "brief_v3", "pdf", now - 1000),
      mk("b", "other thing", "pdf", now - 5000), mk("i1", "design_v1", "png", now - 100), mk("i2", "design_v2", "png", now - 50)];
    const r = ad.query(items, { type: "docs", stack: true }, { a1: { at: 1 }, a2: { at: 1 }, a3: { at: 1 } }, now);
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.items[0].id, "a3");
    assert.strictEqual(r.items[0].versions, 3);
    assert.deepStrictEqual(r.items[0].older.map((o) => o.id), ["a2", "a1"]);
    assert.strictEqual(r.items[1].versions, undefined);
    assert.strictEqual(r.counts.docs, 4); assert.strictEqual(r.counts.image, 2);
    const im = ad.query(items, { type: "image", stack: true }, {}, now);
    assert.deepStrictEqual([im.total, im.items[0].id, im.items[0].versions], [1, "i2", 2]);
    const flat = ad.query(items, { type: "docs" }, {}, now);
    assert.strictEqual(flat.total, 4); // no stack flag: unchanged behaviour
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdocs-"));
  try {
    const w = (p, s = "x") => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), s); };
    w("agent/report.pdf"); w("agent/notes.py"); w("agent/empty.pdf", "");
    w("agent/sub/pic.png"); w("agent/node_modules/x/y.pdf"); w("agent/proj/package.json", "{}"); w("agent/proj/doc.pdf");
    w("agent/tests/t.pdf"); w("agent/~$lock.docx"); w("agent/a/b/c/d/deep.pdf");

    await t("scanRoot skips code/scratch/empty/deep", async () => {
      const got = (await ad.scanRoot(path.join(tmp, "agent"))).map((f) => path.relative(path.join(tmp, "agent"), f.path).replace(/\\/g, "/")).sort();
      assert.deepStrictEqual(got, ["report.pdf", "sub/pic.png"]);
    });

    await t("create(): list, open by id only, no raw path", async () => {
      const opened = [];
      const agent = { path: path.join(tmp, "agent"), folderName: "Test Agent", displayName: "Test" };
      const reg = [{ id: "r1", link: path.join(tmp, "agent", "report.pdf"), title: "Registered report", agent: "Test Agent", status: "active", type: "document" },
        { id: "r2", link: "https://x.test/", agent: "Test", type: "document" }, { id: "r3", link: path.join(tmp, "nope.pdf"), agent: "Test" },
        { id: "r4", link: path.join(tmp, "agent", "report.pdf"), agent: "Someone Else" }];
      const svc = ad.create({
        outputRoot: path.join(tmp, "none"), roots: [tmp], loadRegistry: () => reg, libraryState: { get: () => ({ read: {} }) },
        shell: { openPath: async (p) => { opened.push(p); return ""; }, showItemInFolder() {} }, nativeImage: {}, thumbDir: path.join(tmp, "th"),
      });
      const r = await svc.list(agent, {});
      assert.strictEqual(r.total, 2); // registered report (dedup with folder scan) + pic
      assert.ok(r.items.some((i) => i.id === "r1" && i.title === "Registered report"));
      assert.deepStrictEqual((await svc.open(agent, "../../etc/passwd", "open")).ok, false);
      assert.strictEqual((await svc.open(agent, "r1", "open")).ok, true);
      assert.strictEqual(opened[0], path.join(tmp, "agent", "report.pdf"));
      const v = await svc.open(agent, "r1", "view");
      assert.ok(v.ok && v.url.startsWith("file:///"));
      const s = await svc.summary(agent);
      assert.deepStrictEqual(s, { total: 2, unread: 2 });
    });

    await t("open refuses executables", async () => {
      // an .exe never enters the list (typeOfFile null), so lookup fails
      w("agent/setup.exe");
      const svc = ad.create({ outputRoot: tmp, roots: [tmp], loadRegistry: () => [], libraryState: { get: () => ({ read: {} }) }, shell: {}, nativeImage: {}, thumbDir: tmp });
      const agent = { path: path.join(tmp, "agent"), folderName: "agent" };
      const r = await svc.list(agent, {});
      assert.ok(!r.items.some((i) => i.ext === "exe"));
    });

    await t("registry: allow-list of types and confined to roots; open uses the allow-list", async () => {
      for (const x of ["bad.hta", "bad.wsf", "bad.vbe", "bad.reg", "bad.url", "bad.docm", "bad.exe"]) w("agent/" + x);
      w("outside/secret.pdf");
      const reg = [...["bad.hta", "bad.wsf", "bad.vbe", "bad.reg", "bad.url", "bad.docm", "bad.exe"].map((x, i) => ({ id: "b" + i, link: path.join(tmp, "agent", x), agent: "Test" })),
        { id: "out", link: path.join(tmp, "outside", "secret.pdf"), agent: "Test" },
        { id: "ok", link: path.join(tmp, "agent", "report.pdf"), agent: "Test" }];
      const mkSvc = (roots) => ad.create({ outputRoot: path.join(tmp, "none"), roots, loadRegistry: () => reg, libraryState: { get: () => ({ read: {} }) },
        shell: { openPath: async () => "", showItemInFolder() {} }, nativeImage: {}, thumbDir: path.join(tmp, "th") });
      const agent = { path: path.join(tmp, "agent"), folderName: "Test", displayName: "Test" };
      const svc = mkSvc([path.join(tmp, "agent")]);
      const r = await svc.list(agent, {});
      assert.ok(r.items.some((i) => i.id === "ok"));
      for (const id of ["b0", "b1", "b2", "b3", "b4", "b5", "b6", "out"]) assert.ok(!r.items.some((i) => i.id === id), id + " must be refused");
      assert.strictEqual((await svc.open(agent, "out", "open")).ok, false);
      assert.strictEqual((await svc.open(agent, "out", "view")).ok, false);
      assert.strictEqual((await mkSvc([]).summary(agent)).total, 0); // no roots: nothing is allowed
      assert.strictEqual((await mkSvc([path.join(tmp, "agent")]).summary(agent)).total, 1); // registry-only badge
      // html/md/svg-in-frame are not "view"-able: they go to the default program
      assert.ok(!ad.finishItem({ id: "h", path: "C:\\x\\a.md", title: "a", size: 1, mtimeMs: 1 }).viewable);
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  console.log("agentDocs tests passed: " + n);
})().catch((e) => { console.error(e); process.exit(1); });

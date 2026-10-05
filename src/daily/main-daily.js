// My Daily - main-process side (v1.72.0). Loaded from main.js inside try/catch like IRIS, so a fault here can
// only disable My Daily. LIGHT by design: no timers, nothing runs until the renderer asks (view opened, sidebar
// hover, one badge read after start). The assembled payload is cached for 60 s.
//
// Data (all local JSON under <root>/daily/, atomic writes): settings.json, shopping.json, dates.json,
// appointments.json. Tasks are READ from the shared task store <root>/shared_reports/tasks/<agent>.json
// (tasks.py schema "agent-tasks/1"); in test mode fixtures are used instead. Email and calendar come from
// a provider (providers: placeholder only in this build, clearly labelled "demo data" in the UI).
const fs = require("fs");
const path = require("path");
const model = require("./model");
const linkmeta = require("./linkmeta");
const { execFile } = require("child_process");
const { withFsRetry } = require("../fsRetry");

const CACHE_MS = 60000;

function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  withFsRetry(() => {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, file);
  });
}

// The provider interface. A real provider (Google Calendar, IMAP/Gmail) will implement the same two methods
// and report connected:true; none is built yet, so the placeholder serves the mockups' demo data.
const providers = {
  placeholder: {
    connected: false,
    label: "Not connected - demo data",
    emails: (now) => model.placeholderEmails(now),
    events: (now) => model.placeholderEvents(now),
    accounts: ["Zorg", "Editor", "LensVid contact"],
  },
};

function init({ ipcMain, root, testMode, log, runPython, fetchProduct, makeThumb }) {
  const say = typeof log === "function" ? log : () => {};
  const dir = path.join(root, "daily");
  const f = (n) => path.join(dir, n);
  const taskDir = path.join(root, "shared_reports", "tasks");
  let cache = null;
  const thumbDir = path.join(dir, "thumbs");
  const tasksPy = path.join(root, "shared_tools", "tasks", "tasks.py");
  const fixtureEdits = new Map();   // test mode: edits to fixture tasks live in memory only
  const run = runPython || ((args) => new Promise((resolve, reject) => {
    execFile("python", [tasksPy].concat(args), { timeout: 30000, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().slice(0, 200))) : resolve(out)));
  }));
  const getProduct = fetchProduct || linkmeta.fetchProduct;

  // Test mode may pin the clock (screenshots at a known time of day). Ignored outside test mode.
  const clockNow = () => {
    if (testMode && process.env.AGENT_DESKTOP_DAILY_NOW) {
      const t = Date.parse(process.env.AGENT_DESKTOP_DAILY_NOW);
      if (Number.isFinite(t)) return t;
    }
    return Date.now();
  };

  async function loadTasks(now) {
    if (testMode && process.env.AGENT_DESKTOP_DAILY_REAL_TASKS !== "1") {
      return { tasks: model.fixtureTasks(now).map((t) => (fixtureEdits.has(t.id) ? model.applyTaskEdit(t, fixtureEdits.get(t.id)) : t)), source: "fixture" };
    }
    let names = [];
    try { names = (await fs.promises.readdir(taskDir)).filter((n) => n.endsWith(".json")); } catch (e) { return { tasks: [], source: "missing" }; }
    const stores = await Promise.all(names.map(async (n) => {
      try { return JSON.parse((await fs.promises.readFile(path.join(taskDir, n), "utf8")).replace(/^﻿/, "")); } catch (e) { return null; }
    }));
    return { tasks: model.mapTaskStores(stores.filter(Boolean), now), source: "store" };
  }

  // Reads shopping.json and applies the lazy archive move (done > 1 h -> archive, archive > 90 d -> gone).
  function loadShopping(now) {
    const s = readJson(f("shopping.json"), { lists: [] });
    if (!Array.isArray(s.lists)) s.lists = [];
    if (model.sweepShopping(s, now)) { try { writeJsonAtomic(f("shopping.json"), s); } catch (e) { say(`shopping sweep not saved: ${e.message}`); } }
    return s;
  }
  function saveShopping(s) { writeJsonAtomic(f("shopping.json"), s); cache = null; }

  async function assemble() {
    const now = clockNow();
    const p = providers.placeholder;
    const { tasks, source } = await loadTasks(now);
    const own = readJson(f("appointments.json"), { items: [] });
    const ownEvents = (Array.isArray(own.items) ? own.items : []).filter((e) => e && Number.isFinite(e.start));
    const events = p.events(now).concat(ownEvents).sort((a, b) => a.start - b.start);
    const data = {
      tasks, emails: p.emails(now), events,
      dates: (readJson(f("dates.json"), { items: [] }).items) || [],
      shopping: loadShopping(now),
    };
    const summary = model.summarize(data, now);
    return {
      now, generatedAt: Date.now(), data, summary, digest: model.buildDigest(summary, now), badge: model.badge(summary),
      settings: model.cleanSettings(readJson(f("settings.json"), {})),
      provider: { connected: p.connected, label: p.label, accounts: p.accounts }, taskSource: source, test: !!testMode,
    };
  }

  ipcMain.handle("daily-load", async (e, args) => {
    try {
      if (!(args && args.force) && cache && Date.now() - cache.generatedAt < CACHE_MS) return cache;
      cache = await assemble();
      return cache;
    } catch (err) {
      say(`my daily load failed: ${err.message}`);
      return { error: err.message };
    }
  });

  ipcMain.handle("daily-settings-set", (e, patch) => {
    try {
      const cur = model.cleanSettings(readJson(f("settings.json"), {}));
      const next = model.cleanSettings(Object.assign({}, cur, patch && typeof patch === "object" ? patch : {}));
      writeJsonAtomic(f("settings.json"), next);
      cache = null;
      return { ok: true, settings: next };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("daily-shopping-create-list", (e, args) => {
    try {
      const s = loadShopping(clockNow());
      const r = model.shoppingOp(s, { op: "create-list", name: args && args.name }, clockNow());
      if (r.ok) saveShopping(s);
      return r;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // Thumbnails: download the product image (same SSRF rules), shrink it, keep a small PNG under daily/thumbs/.
  async function makeThumbFor(imageUrl, id) {
    if (makeThumb) return makeThumb(imageUrl, id, thumbDir);
    const r = await linkmeta.guardedGet(imageUrl, "image/*");
    if (r.status >= 400 || !/^image\//i.test(String(r.headers["content-type"] || ""))) return "";
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromBuffer(r.body);
    if (img.isEmpty()) return "";
    const sz = img.getSize();
    const small = img.resize(sz.width >= sz.height ? { width: 120 } : { height: 120 });
    fs.mkdirSync(thumbDir, { recursive: true });
    const name = `${id}.png`;
    fs.writeFileSync(path.join(thumbDir, name), small.toPNG());
    return name;
  }

  ipcMain.handle("daily-shopping", async (e, args) => {
    try {
      const a = args || {};
      const now = clockNow();
      const s = loadShopping(now);
      if (a.op === "share") {
        const l = model.findList(s, a.listId);
        return l ? { ok: true, text: model.shoppingShareText(l) } : { ok: false, reason: "That list no longer exists." };
      }
      if (a.op === "add-link") {
        if (!model.findList(s, a.listId)) return { ok: false, reason: "That list no longer exists." };
        const m = await getProduct(String(a.url || "").trim());
        if (m.rejected) return { ok: false, reason: m.reason };
        const op = { op: "add", listId: a.listId, addedBy: a.addedBy, fromLink: true, link: m.link, source: m.source, price: m.price };
        op.text = m.found && m.title ? m.title : `Link from ${m.source || "the web"}`;
        if (!m.found) op.detailsMissing = true;
        const s2 = loadShopping(now);   // re-read: the fetch took a while
        const r = model.shoppingOp(s2, op, now);
        if (!r.ok) return r;
        if (m.found && m.image) {
          try { const t = await makeThumbFor(m.image, r.item.id); if (t) r.item.thumb = t; } catch (err) { say(`thumbnail failed: ${err.message}`); }
        }
        saveShopping(s2);
        return { ok: true, detailsMissing: !!op.detailsMissing, reason: m.reason };
      }
      let thumb = null;
      if (a.op === "remove") { const l = model.findList(s, a.listId); const it = l && (l.items || []).find((x) => x.id === a.itemId); thumb = it && it.thumb; }
      const r = model.shoppingOp(s, a, now);
      if (r.ok) {
        saveShopping(s);
        if (thumb && /^[\w-]+\.png$/.test(thumb)) fs.promises.unlink(path.join(thumbDir, thumb)).catch(() => {});
      }
      return r.ok ? { ok: true } : r;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("daily-thumbs", async (e, names) => {
    const out = {};
    for (const n of (Array.isArray(names) ? names : []).slice(0, 100)) {
      if (!/^[\w-]+\.png$/.test(String(n))) continue;
      try { out[n] = "data:image/png;base64," + (await fs.promises.readFile(path.join(thumbDir, n))).toString("base64"); } catch (err) { /* missing thumb: shown without */ }
    }
    return out;
  });

  ipcMain.handle("daily-task-edit", async (e, args) => {
    try {
      const a = args || {};
      const change = { status: a.status || undefined, priority: a.priority || undefined };
      const { tasks, source } = await loadTasks(clockNow());
      const t = tasks.find((x) => x.id === a.id && x.agent === a.agent);
      if (!t) return { ok: false, reason: "That task is no longer open." };
      const cliArgs = model.taskEditArgs(t, change);   // validates the change
      if (source === "fixture") fixtureEdits.set(t.id, Object.assign({}, fixtureEdits.get(t.id), change));
      else await run(cliArgs);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("daily-dates-save", (e, raw) => {
    try {
      const c = model.cleanDate(raw || {});
      if (c.error) return { ok: false, reason: c.error };
      const d = readJson(f("dates.json"), { items: [] });
      if (!Array.isArray(d.items)) d.items = [];
      const i = d.items.findIndex((x) => x.id === c.item.id);
      if (i >= 0) d.items[i] = c.item; else d.items.push(c.item);
      writeJsonAtomic(f("dates.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  ipcMain.handle("daily-dates-delete", (e, args) => {
    try {
      const d = readJson(f("dates.json"), { items: [] });
      d.items = (d.items || []).filter((x) => x.id !== (args && args.id));
      writeJsonAtomic(f("dates.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
}

module.exports = { init, readJson, writeJsonAtomic, providers };

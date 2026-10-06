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
const mailfeed = require("./mailfeed");
const { execFile } = require("child_process");
const { withFsRetry } = require("../fsRetry");

const CACHE_MS = 60000;

const MAX_ITEMS = 5000;                      // appointments / dates kept per store
const MAX_STORE_BYTES = 25 * 1024 * 1024;   // a store bigger than this is treated as damaged, never loaded

function parseText(txt) { return JSON.parse(String(txt).replace(/^\uFEFF/, "")); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

// Plain reader (no recovery): used where a missing/odd file just means "nothing yet".
function readJson(file, fallback) {
  try {
    const v = parseText(fs.readFileSync(file, "utf8"));
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// Reader with recovery. Missing file -> fallback (a fresh start). Oversized, not JSON or not an object ->
// the damaged file is kept as <file>.corrupt-<time>, the previous good copy <file>.bak is restored when it is valid,
// and a notice is recorded so My Daily can say so. A file that merely cannot be read right now (locked) is left
// untouched. Never throws.
function readStore(file, fallback, notices, label) {
  let txt;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_STORE_BYTES) throw Object.assign(new Error("file is too large"), { code: "ETOOBIG" });
    txt = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return fallback;
    if (!(e && e.code === "ETOOBIG")) { note(notices, label, `could not be read (${e && e.code ? e.code : "error"}); showing it empty. Nothing was overwritten.`); return fallback; }
    return recover(file, fallback, notices, label, e.message);
  }
  try {
    const v = parseText(txt);
    if (!isObj(v)) throw new Error("not an object");
    return v;
  } catch (e) {
    return recover(file, fallback, notices, label, e.message);
  }
}
function note(notices, label, text) {
  if (!notices) return;
  const msg = `${label} ${text}`;
  if (!notices.includes(msg)) notices.push(msg);
}
function recover(file, fallback, notices, label, why) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const kept = `${file}.corrupt-${stamp}`;
  let keptOk = true;
  try { fs.renameSync(file, kept); } catch (e) { keptOk = false; }
  let restored = null;
  try {
    const st = fs.statSync(file + ".bak");
    if (st.size <= MAX_STORE_BYTES) { const v = parseText(fs.readFileSync(file + ".bak", "utf8")); if (isObj(v)) restored = v; }
  } catch (e) { /* no usable backup */ }
  if (restored) {
    try { fs.copyFileSync(file + ".bak", file); } catch (e) { /* the restored data is still used for this run */ }
    note(notices, label, `was damaged (${why}); the last good copy was restored. The damaged file was kept as ${path.basename(kept)}.`);
    return restored;
  }
  note(notices, label, keptOk ? `was damaged (${why}) and no backup exists, so it starts empty. The damaged file was kept as ${path.basename(kept)}.` : `was damaged (${why}); it could not be moved aside, so it will be replaced on the next save.`);
  return fallback;
}

// Atomic write: temp file in the same folder, then rename. The previous version is kept as <file>.bak first.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(value, null, 2);
  if (text.length > MAX_STORE_BYTES) throw new Error("That would make the file too large to keep safely.");
  try {
    withFsRetry(() => {
      fs.writeFileSync(tmp, text, "utf8");
      try { fs.copyFileSync(file, file + ".bak"); } catch (e) { /* first write: nothing to back up */ }
      fs.renameSync(tmp, file);
    });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    throw e;
  }
}

// The provider interface. A real provider (Google Calendar, IMAP/Gmail) will implement the same two methods
// and report connected:true; none is built yet, so the placeholder serves the mockups' demo data.
const providers = {
  placeholder: {
    connected: false,
    label: "Not connected - demo data",
    emails: (now) => model.placeholderEmails(now),
    events: (now) => model.placeholderEvents(now),
    accounts: ["Personal", "Editor", "Contact"],
  },
};

function init({ ipcMain: rawIpc, root, testMode, log, runPython, fetchProduct, makeThumb, getMainWindow }) {
  const say = typeof log === "function" ? log : () => {};
  const notices = [];   // damaged-store notices, kept until dismissed (daily-notices-clear)
  // Every daily-* channel: only the main window's own frame may call it (same idea as IRIS), and an oversized
  // argument is refused before any handler looks at it. With no main window known, everything is refused.
  const MAX_ARG_CHARS = 262144;
  const ipcMain = {
    handle: (channel, fn) => rawIpc.handle(channel, (event, arg) => {
      try {
        const w = typeof getMainWindow === "function" ? getMainWindow() : null;
        const wc = w && !(typeof w.isDestroyed === "function" && w.isDestroyed()) ? w.webContents : null;
        if (!wc || !event || event.sender !== wc || (event.senderFrame && wc.mainFrame && event.senderFrame !== wc.mainFrame)) { say(`${channel} refused: not the main window`); return { ok: false, reason: "Not allowed." }; }
        if (arg !== undefined && arg !== null) {
          let n = 0;
          try { n = JSON.stringify(arg).length; } catch (e) { return { ok: false, reason: "Bad request." }; }
          if (n > MAX_ARG_CHARS) return { ok: false, reason: "That request is too large." };
        }
      } catch (e) { return { ok: false, reason: "Not allowed." }; }
      return fn(event, arg);
    }),
  };
  const dir = path.join(root, "daily");
  const f = (n) => path.join(dir, n);
  const taskDir = path.join(root, "shared_reports", "tasks");
  let cache = null;
  let skippedTaskFiles = 0;
  const thumbDir = path.join(dir, "thumbs");
  const tasksPy = path.join(root, "shared_tools", "tasks", "tasks.py");
  const fixtureAdded = [];          // test mode: tasks added by voice live in memory only
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
      return { tasks: model.fixtureTasks(now).concat(fixtureAdded).map((t) => (fixtureEdits.has(t.id) ? model.applyTaskEdit(t, fixtureEdits.get(t.id)) : t)), source: "fixture" };
    }
    let names = [];
    try { names = (await fs.promises.readdir(taskDir)).filter((n) => n.endsWith(".json")); } catch (e) { return { tasks: [], source: "missing" }; }
    skippedTaskFiles = 0;
    const stores = await Promise.all(names.map(async (n) => {
      try {
        const file = path.join(taskDir, n);
        if ((await fs.promises.stat(file)).size > MAX_STORE_BYTES) throw new Error("too large");
        const v = parseText(await fs.promises.readFile(file, "utf8"));
        if (!isObj(v)) throw new Error("not an object");
        return v;
      } catch (e) { skippedTaskFiles++; return null; }
    }));
    return { tasks: model.mapTaskStores(stores.filter(Boolean), now), source: "store" };
  }

  // Reads shopping.json and applies the lazy archive move (done > 1 h -> archive, archive > 90 d -> gone).
  function loadShopping(now) {
    const s = model.cleanShopping(readStore(f("shopping.json"), { lists: [] }, notices, "Shopping lists"));
    if (model.sweepShopping(s, now)) { try { writeJsonAtomic(f("shopping.json"), s); } catch (e) { say(`shopping sweep not saved: ${e.message}`); } }
    return s;
  }
  function saveShopping(s) { writeJsonAtomic(f("shopping.json"), s); cache = null; }

  async function assemble() {
    const now = clockNow();
    const p = providers.placeholder;
    const { tasks, source } = await loadTasks(now);
    const own = readStore(f("appointments.json"), { items: [] }, notices, "Appointments");
    const ownEvents = (Array.isArray(own.items) ? own.items : []).filter((e) => e && Number.isFinite(e.start)).map((e) => Object.assign({ cal: "iddo" }, e, { own: true }));
    const events = p.events(now).concat(ownEvents).sort((a, b) => a.start - b.start);
    // Real email from the local Betterbird feed (read-only file written by the Personal Assistant) when it is readable;
    // otherwise the placeholder demo data. Calendar stays on the placeholder until Google Calendar is connected.
    const feed = testMode ? { connected: false } : mailfeed.loadMailFeed(process.env.DAILY_MAIL_FEED || undefined, now);
    const data = {
      tasks, emails: feed.connected ? feed.emails : p.emails(now), events,
      dates: (() => { const d = readStore(f("dates.json"), { items: [] }, notices, "Birthdays & dates").items; return Array.isArray(d) ? d.filter(isObj) : []; })(),
      shopping: loadShopping(now),
    };
    const summary = model.summarize(data, now);
    return {
      now, generatedAt: Date.now(), data, summary, digest: model.buildDigest(summary, now), badge: model.badge(summary),
      settings: model.cleanSettings(readStore(f("settings.json"), {}, notices, "Settings")),
      notices: notices.concat(skippedTaskFiles ? [`${skippedTaskFiles} task file${skippedTaskFiles === 1 ? "" : "s"} could not be read and ${skippedTaskFiles === 1 ? "is" : "are"} left out.`] : []),
      provider: { connected: p.connected, label: p.label, accounts: feed.connected ? feed.accounts : p.accounts, emailsConnected: !!feed.connected, emailsLabel: feed.connected ? feed.label : "", emailsUpdatedAt: feed.connected ? feed.updatedAt : null, emailsCounts: feed.connected ? feed.counts : null }, taskSource: source, test: !!testMode,
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

  ipcMain.handle("daily-notices-clear", () => { notices.length = 0; cache = null; return { ok: true }; });

  ipcMain.handle("daily-settings-set", (e, patch) => {
    try {
      const cur = model.cleanSettings(readStore(f("settings.json"), {}, notices, "Settings"));
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

  // Voice: a new task through the same tasks.py runner the edits use (test mode: in-memory fixture, nothing is written).
  ipcMain.handle("daily-task-add", async (e, raw) => {
    try {
      const c = model.cleanNewTask(raw);
      if (c.error) return { ok: false, reason: c.error };
      const t = c.task;
      if (testMode && process.env.AGENT_DESKTOP_DAILY_REAL_TASKS !== "1") {
        const now = clockNow();
        fixtureAdded.push({ id: "v" + (fixtureAdded.length + 1), agent: t.agent, title: t.title, detail: "", status: "working", priority: t.priority, tags: t.tags, area: t.area, list: t.list, created: new Date(now).toISOString(), ageDays: 0 });
      } else await run(model.taskAddArgs(t));
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // Own appointments (appointments.json). Placeholder/provider events are never written here.
  ipcMain.handle("daily-appointment-save", (e, raw) => {
    try {
      const c = model.cleanAppointment(raw || {});
      if (c.error) return { ok: false, reason: c.error };
      const d = readStore(f("appointments.json"), { items: [] }, notices, "Appointments");
      if (!Array.isArray(d.items)) d.items = [];
      if (d.items.length >= MAX_ITEMS && !d.items.some((x) => x && x.id === c.item.id)) return { ok: false, reason: "That list is full." };
      const i = d.items.findIndex((x) => x.id === c.item.id);
      if (i >= 0) d.items[i] = c.item; else d.items.push(c.item);
      writeJsonAtomic(f("appointments.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  ipcMain.handle("daily-appointment-delete", (e, args) => {
    try {
      const d = readStore(f("appointments.json"), { items: [] }, notices, "Appointments");
      d.items = (d.items || []).filter((x) => x.id !== (args && args.id));
      writeJsonAtomic(f("appointments.json"), d);
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
      const d = readStore(f("dates.json"), { items: [] }, notices, "Birthdays & dates");
      if (!Array.isArray(d.items)) d.items = [];
      if (d.items.length >= MAX_ITEMS && !d.items.some((x) => x && x.id === c.item.id)) return { ok: false, reason: "That list is full." };
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
      const d = readStore(f("dates.json"), { items: [] }, notices, "Birthdays & dates");
      d.items = (d.items || []).filter((x) => x.id !== (args && args.id));
      writeJsonAtomic(f("dates.json"), d);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
}

module.exports = { init, readJson, readStore, writeJsonAtomic, providers };

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

function init({ ipcMain, root, testMode, log }) {
  const say = typeof log === "function" ? log : () => {};
  const dir = path.join(root, "daily");
  const f = (n) => path.join(dir, n);
  const taskDir = path.join(root, "shared_reports", "tasks");
  let cache = null;

  // Test mode may pin the clock (screenshots at a known time of day). Ignored outside test mode.
  const clockNow = () => {
    if (testMode && process.env.AGENT_DESKTOP_DAILY_NOW) {
      const t = Date.parse(process.env.AGENT_DESKTOP_DAILY_NOW);
      if (Number.isFinite(t)) return t;
    }
    return Date.now();
  };

  async function loadTasks(now) {
    if (testMode && process.env.AGENT_DESKTOP_DAILY_REAL_TASKS !== "1") return { tasks: model.fixtureTasks(now), source: "fixture" };
    let names = [];
    try { names = (await fs.promises.readdir(taskDir)).filter((n) => n.endsWith(".json")); } catch (e) { return { tasks: [], source: "missing" }; }
    const stores = await Promise.all(names.map(async (n) => {
      try { return JSON.parse((await fs.promises.readFile(path.join(taskDir, n), "utf8")).replace(/^﻿/, "")); } catch (e) { return null; }
    }));
    return { tasks: model.mapTaskStores(stores.filter(Boolean), now), source: "store" };
  }

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
      shopping: readJson(f("shopping.json"), { lists: [] }),
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

  // Phase 1 minimum for the empty state's "+ New list"; the full shopping features arrive in the next phase.
  ipcMain.handle("daily-shopping-create-list", (e, args) => {
    try {
      const name = String((args && args.name) || "").trim().slice(0, 60);
      if (!name) return { ok: false, reason: "A list needs a name." };
      const s = readJson(f("shopping.json"), { lists: [] });
      if (!Array.isArray(s.lists)) s.lists = [];
      if (s.lists.some((l) => l.name.toLowerCase() === name.toLowerCase())) return { ok: false, reason: "There is already a list with that name." };
      s.lists.push({ id: "l" + Date.now().toString(36), name, created: new Date().toISOString(), items: [] });
      writeJsonAtomic(f("shopping.json"), s);
      cache = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
}

module.exports = { init, readJson, writeJsonAtomic, providers };

// Per-agent "Agent documents" side panel (v1.75.0 work, Iddo green light 2026-10-05).
//
// Lists the finished files ONE agent produced: its registry entries (shared_registry, by owner) plus
// finished-looking files found under the agent's own folder and its E:\Claude work output folder.
// Not code, not scratch. Read-only: it never writes to a registry or an agent folder.
//
// Light on purpose (weak PCs): nothing is scanned or thumbnailed until the panel is opened for that
// agent; the folder scan is async, shallow, capped and cached; thumbnails are made lazily, at most
// THUMB_CONCURRENCY at a time, and cached on disk.
//
// Opening goes by item id. The renderer never supplies a path: main keeps id -> path for the
// last listing of each agent and looks it up itself (same rule as registry.js).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PAGE_SIZE = 40;
const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_VISITED = 4000; // directory entries looked at per root
const SCAN_MAX_MS = 1500; // wall-clock budget per root
const SCAN_CACHE_MS = 120000;
const THUMB_CONCURRENCY = 6;
const THUMB_MAX_DIM = 320;

// What counts as a finished document, and which group the filter pills show it under.
const TYPE_OF_EXT = {
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", tif: "image", tiff: "image", heic: "image",
  doc: "word", docx: "word", odt: "word", rtf: "word",
  xls: "sheet", xlsx: "sheet", csv: "sheet", ods: "sheet",
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video", m4v: "video",
  ppt: "other", pptx: "other", dwg: "other", dxf: "other", step: "other", stp: "other", stl: "other", mp3: "other", wav: "other", zip: "other",
};
// What the built-in viewer can show (the rest is "open externally").
// No html/md/svg-in-a-frame: anything that can run script goes to the default program instead (reviewed 2026-10-06).
const VIEWABLE_EXT = /^(pdf|png|jpe?g|gif|webp|bmp|svg|mp4|webm|m4v)$/i;

// Folders that hold code, environments, caches or scratch - never listed, never walked into.
const SKIP_DIR = new Set([
  "node_modules", ".git", "venv", ".venv", "env", "__pycache__", "dist", "build", "out", "tmp", "temp", "cache", ".cache",
  "backups", "backup", "logs", "log", "memory", "handoff_history", "shots", "screenshots", "test", "tests", "fixtures",
  "playwright-browsers", "hf-cache", "site-packages", "_holding", ".claude", ".claude-session", "sessions",
]);
// Folders that are themselves a code project or environment: skipped unless they are the root.
const PROJECT_MARKERS = ["pyvenv.cfg", "package.json", ".git"];
// Files that look like plumbing even when the extension matches.
const SKIP_FILE = /(^~\$|\.tmp$|\.bak|thumbs\.db$|desktop\.ini$|^\.|_thumb\.|\.thumb\.)/i;

function typeOfFile(name) {
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  return TYPE_OF_EXT[ext] || null;
}

// "UI-UX Agent", "UI/UX Agent", "UI/UX" -> "uiux"; "Software Engineering Agent" -> "softwareengineering".
function normAgent(s) {
  return String(s || "").toLowerCase().replace(/\bagent\b/g, "").replace(/[^a-z0-9]/g, "");
}

function matchesAgent(entryAgent, names) {
  const n = normAgent(entryAgent);
  return !!n && names.some((x) => normAgent(x) === n);
}

function idForPath(p) {
  return "f-" + crypto.createHash("sha1").update(String(p).toLowerCase()).digest("hex").slice(0, 20);
}

// ---- folder scan -------------------------------------------------------------------------------

async function scanRoot(root, isRoot = true, depth = 0, budget = null) {
  const b = budget || { visited: 0, until: Date.now() + SCAN_MAX_MS };
  const out = [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  if (!isRoot && entries.some((d) => PROJECT_MARKERS.includes(d.name))) return out;
  for (const d of entries) {
    if (b.visited++ > SCAN_MAX_VISITED || Date.now() > b.until) break;
    if (b.visited % 200 === 0) await new Promise((r) => setImmediate(r)); // let the UI breathe
    const full = path.join(root, d.name);
    if (d.isDirectory()) {
      if (depth < SCAN_MAX_DEPTH && !SKIP_DIR.has(d.name.toLowerCase()) && !d.name.startsWith(".")) {
        out.push(...(await scanRoot(full, false, depth + 1, b)));
      }
    } else if (d.isFile() && typeOfFile(d.name) && !SKIP_FILE.test(d.name)) {
      try {
        const st = await fs.promises.stat(full);
        if (st.size > 0) out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      } catch (e) { /* vanished mid-scan */ }
    }
  }
  return out;
}

// ---- building the list -------------------------------------------------------------------------

// True when file `p` really lives under one of `roots` (symlinks/junctions resolved, case-insensitive).
function underRoots(p, roots) {
  let real;
  try { real = fs.realpathSync(p).toLowerCase(); } catch (e) { return false; }
  return (roots || []).some((r) => {
    try {
      const rr = fs.realpathSync(r).toLowerCase();
      const rel = path.relative(rr, real);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    } catch (e) { return false; }
  });
}

function registryItems(entries, names, roots) {
  const out = [];
  for (const e of entries) {
    if (!e || !e.id || !e.link || /^https?:\/\//i.test(e.link) || e.type === "project") continue;
    if (!matchesAgent(e.agent, names)) continue;
    if (!typeOfFile(e.link) || !underRoots(e.link, roots)) continue; // allow-list of types, confined to the known roots
    let st;
    try { st = fs.statSync(e.link); } catch (err) { continue; } // registry points at nothing: not a document we can show
    if (!st.isFile()) continue;
    out.push({
      id: String(e.id), path: e.link, title: e.title || path.basename(e.link), size: st.size,
      mtimeMs: Date.parse(e.updatedAt || e.createdAt || "") || st.mtimeMs,
      status: ["active", "draft", "superseded"].includes(e.status) ? e.status : e.status === "stale" ? "" : (e.status || ""),
      note: [e.description, e.topic].filter(Boolean).join(" "), source: "registry",
    });
  }
  return out;
}

function scannedItems(files, skipPaths) {
  return files
    .filter((f) => !skipPaths.has(String(f.path).toLowerCase()))
    .map((f) => ({
      id: idForPath(f.path), path: f.path, title: path.basename(f.path, path.extname(f.path)).replace(/[_]+/g, " "),
      size: f.size, mtimeMs: f.mtimeMs, status: "", note: "", source: "folder",
    }));
}

function finishItem(it) {
  const name = path.basename(it.path);
  const ext = path.extname(name).slice(1).toLowerCase();
  return { ...it, name, ext, type: TYPE_OF_EXT[ext] || "other", viewable: VIEWABLE_EXT.test(ext) };
}

function dayGroup(ms, now) {
  const d = new Date(ms), n = new Date(now);
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ms >= startToday) return "Today";
  if (ms >= startToday - 6 * 86400000) return "This week";
  return d.toLocaleString("en-US", { month: "long", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
}

// "Report_v2", "report draft5", "plan_FINAL", "x (1)", "x_2026-10-05" -> same stem "report"/"plan"/"x": versions of one document.
const VERSION_TAIL = /[\s_.-]*(\(\d+\)|v\d+(\.\d+)*|ver\d+|rev\d+|r\d+|draft\d*|final|new|copy|round\d+|\d{4}[-_]\d{2}[-_]\d{2}|\d{8}|[_ -]\d{1,3})$/i;
function stemKey(name) {
  let s = path.basename(String(name), path.extname(String(name))).toLowerCase();
  for (let i = 0; i < 4; i++) {
    const t = s.replace(VERSION_TAIL, "");
    if (t === s || !t.trim()) break;
    s = t;
  }
  return s.replace(/[\s_.-]+/g, " ").trim();
}

// Pure: items (already finished) + a query -> one page. `read` maps id -> {at}.
function query(items, q, read, now = Date.now()) {
  q = q || {};
  const search = String(q.search || "").trim().toLowerCase();
  const type = q.type && q.type !== "all" ? String(q.type) : null;
  const dir = q.sort === "oldest" ? 1 : -1;
  const counts = { all: 0, docs: 0, pdf: 0, image: 0, word: 0, sheet: 0, video: 0, other: 0 };
  let unread = 0;
  const matched = [];
  for (const it of items) {
    if (search && !(it.title.toLowerCase().includes(search) || it.name.toLowerCase().includes(search) || (it.note || "").toLowerCase().includes(search))) continue;
    counts.all++; counts[it.type]++;
    if (it.type !== "image") counts.docs++;
    if (!(read && read[it.id])) unread++;
    if (!type || it.type === type || (type === "docs" && it.type !== "image")) matched.push(it);
  }
  matched.sort((a, b) => dir * (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name));
  const offset = Math.max(0, Number(q.offset) || 0);
  const row = (it) => ({
    id: it.id, title: it.title, name: it.name, ext: it.ext, type: it.type, size: it.size, mtimeMs: it.mtimeMs, status: it.status,
    viewable: it.viewable, unread: !(read && read[it.id]), group: dayGroup(it.mtimeMs, now), source: it.source,
  });
  let stacks = matched.map((it) => ({ head: it, older: [] }));
  if (q.stack) { // one stack per document: the newest version leads, older ones fold under it
    const by = new Map();
    stacks = [];
    for (const it of matched) {
      const k = it.type + "|" + stemKey(it.name);
      if (by.has(k)) by.get(k).older.push(it);
      else { const st = { head: it, older: [] }; by.set(k, st); stacks.push(st); }
    }
  }
  const page = stacks.slice(offset, offset + PAGE_SIZE).map((st) => {
    const r = row(st.head);
    if (st.older.length) { r.versions = st.older.length + 1; r.older = st.older.map(row); r.unread = r.unread || r.older.some((o) => o.unread); }
    return r;
  });
  return { total: stacks.length, counts, unread, offset, pageSize: PAGE_SIZE, items: page };
}

// ---- stateful part (electron-facing) -----------------------------------------------------------

// deps: { workspaceRoot, outputRoot, loadRegistry(): entries, libraryState, shell, nativeImage, thumbDir }
function create(deps) {
  const lists = new Map(); // agentKey -> { at, items, byId }
  const pending = new Map(); // agentKey -> Promise (de-duplicates concurrent scans)

  function agentRoots(agent) {
    const roots = [];
    if (agent.path) roots.push(agent.path);
    try {
      const want = normAgent(agent.folderName || agent.displayName);
      for (const d of fs.readdirSync(deps.outputRoot, { withFileTypes: true })) {
        if (d.isDirectory() && normAgent(d.name) === want && want) roots.push(path.join(deps.outputRoot, d.name));
      }
    } catch (e) { /* no output folder for this agent */ }
    return roots;
  }

  async function build(agent) {
    const names = [agent.folderName, agent.displayName].filter(Boolean);
    const reg = registryItems(deps.loadRegistry(), names, deps.roots);
    const skip = new Set(reg.map((r) => String(r.path).toLowerCase()));
    const files = [];
    for (const r of agentRoots(agent)) files.push(...(await scanRoot(r)));
    const items = [...reg, ...scannedItems(files, skip)].map(finishItem);
    const byId = new Map(items.map((i) => [i.id, i]));
    return { at: Date.now(), items, byId };
  }

  async function listing(agent, force) {
    const key = agent.path;
    const hit = lists.get(key);
    if (hit && !force && Date.now() - hit.at < SCAN_CACHE_MS) return hit;
    if (!pending.has(key)) {
      pending.set(key, build(agent).then((l) => { lists.set(key, l); return l; }).finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  async function list(agent, q) {
    const l = await listing(agent, !!(q && q.refresh));
    return query(l.items, q, deps.libraryState.get().read);
  }

  // Counts only (for the header badge) - same cache, no page built.
  // Cheap on purpose: the header badge asks on every agent selection, so without a cached full listing it
  // counts registry entries only (no folder scan). The full scan happens when the panel opens.
  async function summary(agent) {
    const read = deps.libraryState.get().read;
    const hit = lists.get(agent.path);
    let items;
    if (hit && Date.now() - hit.at < SCAN_CACHE_MS) items = hit.items;
    else {
      const names = [agent.folderName, agent.displayName].filter(Boolean);
      items = registryItems(deps.loadRegistry(), names, deps.roots);
    }
    return { total: items.length, unread: items.filter((i) => !read[i.id]).length };
  }

  function lookup(agent, id) {
    const l = lists.get(agent.path);
    return l && l.byId.get(String(id || "")) || null;
  }

  async function open(agent, id, how) {
    const it = lookup(agent, id);
    if (!it) return { ok: false, error: "That file is not in the list any more - refresh the panel." };
    if (!fs.existsSync(it.path)) return { ok: false, error: "The file is no longer at " + it.path };
    if (how === "reveal") { deps.shell.showItemInFolder(it.path); return { ok: true }; }
    if (how === "view") {
      if (!it.viewable) return { ok: false, error: "The built-in viewer cannot show ." + it.ext + " files - use Open externally." };
      const url = "file:///" + it.path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
      return { ok: true, url, title: it.title, type: it.type, ext: it.ext, path: it.path };
    }
    // Allow-list, not deny-list: only the document types in TYPE_OF_EXT ever reach shell.openPath.
    if (!typeOfFile(it.path)) return { ok: false, error: "That file type is not opened from here." };
    const err = await deps.shell.openPath(it.path);
    return err ? { ok: false, error: err } : { ok: true };
  }

  // ---- thumbnails: lazy, <= THUMB_CONCURRENCY at a time, cached on disk as small JPEGs ----
  let active = 0;
  const waiting = [];
  function slot() {
    return new Promise((res) => { if (active < THUMB_CONCURRENCY) { active++; res(); } else waiting.push(res); });
  }
  function release() { const next = waiting.shift(); if (next) next(); else active--; }

  async function thumbnail(agent, id) {
    const it = lookup(agent, id);
    if (!it || !["image", "pdf", "video", "word"].includes(it.type)) return { ok: false };
    let st;
    try { st = await fs.promises.stat(it.path); } catch (e) { return { ok: false }; }
    const key = crypto.createHash("sha1").update(`${it.path}|${st.mtimeMs}|${st.size}`).digest("hex");
    const out = path.join(deps.thumbDir, key + ".jpg");
    if (fs.existsSync(out)) return { ok: true, path: out };
    await slot();
    try {
      if (fs.existsSync(out)) return { ok: true, path: out };
      let img;
      if (it.type === "image" && it.ext !== "svg" && it.ext !== "heic") img = deps.nativeImage.createFromPath(it.path);
      if ((!img || img.isEmpty()) && deps.nativeImage.createThumbnailFromPath) {
        // Windows shell thumbnails: PDF, Word, video (and images the decoder could not read).
        img = await deps.nativeImage.createThumbnailFromPath(it.path, { width: THUMB_MAX_DIM, height: THUMB_MAX_DIM });
      }
      if (!img || img.isEmpty()) return { ok: false };
      const { width, height } = img.getSize();
      const scale = Math.min(1, THUMB_MAX_DIM / Math.max(width, height, 1));
      const small = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
      fs.mkdirSync(deps.thumbDir, { recursive: true });
      fs.writeFileSync(out, small.toJPEG(75));
      return { ok: true, path: out };
    } catch (e) {
      return { ok: false };
    } finally {
      release();
    }
  }

  return { list, summary, open, thumbnail, lookup, _lists: lists };
}

module.exports = {
  create, query, stemKey, typeOfFile, normAgent, matchesAgent, idForPath, underRoots, scanRoot, registryItems, scannedItems, finishItem, dayGroup,
  PAGE_SIZE, THUMB_CONCURRENCY,
};

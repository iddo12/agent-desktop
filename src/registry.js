// The Library: Projects / Documents / Images tabs over the shared workspace
// registry (v1.38.0).
//
// The registry is shared_tools\registry.py's store - one JSON file per entry
// in <workspace>\shared_registry\. It is a root CLAUDE.md standing order
// (2026-09-22) that every agent registers the documents it writes and the
// things Iddo can open, so this view answers "what have we made, and where
// is it?" without him remembering links or asking an agent to dig one up.
//
// Read-only here. Adding and editing stays with registry.py, which owns the
// id scheme, the image copying and the confirmedAt clock.
//
// Opening goes by ENTRY ID, never by a path handed over from the renderer:
// the main process looks the link up itself, so this IPC cannot be used to
// open an arbitrary file or URL.

const fs = require("fs");
const path = require("path");
const { shell, clipboard } = require("electron");

const STALE_AFTER_DAYS = 90; // same as registry.py

function registryDir(workspaceRoot) {
  return path.join(workspaceRoot, "shared_registry");
}

function loadEntries(workspaceRoot) {
  const dir = registryDir(workspaceRoot);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch (e) {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (e && e.id && e.type) out.push(e);
    } catch (err) {
      /* mid-write (registry.py writes via a temp file, but be safe) */
    }
  }
  return out;
}

function isUrl(link) {
  return /^https?:\/\//i.test(String(link || ""));
}

function viewablePath(e) {
  const candidates = [e.pdf, e.link].filter((p) => p && !isUrl(p));
  for (const p of candidates) {
    if (/\.(pdf|png|jpe?g|gif|webp|html?)$/i.test(p) && fs.existsSync(p)) return p;
  }
  return null;
}

function listRegistry(workspaceRoot) {
  const now = Date.now();
  return loadEntries(workspaceRoot)
    .map((e) => {
      const local = e.link && !isUrl(e.link);
      const confirmed = Date.parse(e.confirmedAt || e.updatedAt || e.createdAt || "");
      const thumb = e.thumbnail || (e.type === "image" ? e.link : null);
      return {
        id: e.id,
        type: e.type,
        title: e.title || e.id,
        description: e.description || "",
        agent: e.agent || "",
        topic: e.topic || "",
        link: e.link || "",
        isUrl: isUrl(e.link),
        // A local link that no longer exists is worth showing plainly - the
        // registry is only useful if it does not quietly point at nothing.
        missing: !!(local && !fs.existsSync(e.link)),
        thumbnail: thumb && !isUrl(thumb) && fs.existsSync(thumb) ? thumb : null,
        // What the in-app viewer can show: the entry's PDF copy if it has one,
        // else a local PDF/image/HTML link. Web links open in the browser.
        viewable: !!viewablePath(e),
        status: e.status || "active",
        updatedAt: e.updatedAt || e.createdAt || null,
        staleDays: Number.isFinite(confirmed) ? Math.floor((now - confirmed) / 86400000) : null,
      };
    })
    .map((e) => ({ ...e, stale: e.staleDays != null && e.staleDays > STALE_AFTER_DAYS }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function findEntry(workspaceRoot, id) {
  return loadEntries(workspaceRoot).find((e) => e.id === id) || null;
}

async function registryAction(workspaceRoot, id, action) {
  const e = findEntry(workspaceRoot, id);
  if (!e || !e.link) return { ok: false, error: "No such entry, or it has no link." };
  if (action === "copy") {
    clipboard.writeText(e.link);
    return { ok: true };
  }
  if (action === "view") {
    // In-app viewer: returns a file:// URL for the renderer's viewer frame.
    // Still looked up by entry id only - the renderer never supplies a path.
    const p = viewablePath(e);
    if (!p) return { ok: false, error: "Nothing viewable inside the app for this entry." };
    return { ok: true, url: "file:///" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:"), title: e.title };
  }
  if (action === "openPdf" && e.pdf && fs.existsSync(e.pdf)) {
    const err = await shell.openPath(e.pdf);
    return err ? { ok: false, error: err } : { ok: true };
  }
  if (isUrl(e.link)) {
    if (action !== "open") return { ok: false, error: "That entry is a web link, not a file." };
    await shell.openExternal(e.link);
    return { ok: true };
  }
  if (!fs.existsSync(e.link)) return { ok: false, error: "The file is no longer at " + e.link };
  if (action === "reveal") {
    shell.showItemInFolder(e.link);
    return { ok: true };
  }
  const err = await shell.openPath(e.link); // "" on success
  return err ? { ok: false, error: err } : { ok: true };
}

// Clickable PDF paths in chat bubbles (v1.52.0). Unlike registryAction this
// DOES take a path from the renderer - an agent's reply is the source - so
// main treats it as untrusted: a plain drive-letter path only (no UNC, no
// \\?\ device paths, no alternate data streams), resolved and then
// realpath'd so neither ".." nor a junction/symlink can step outside the
// allowed roots, an existing regular file, and a .pdf extension on the REAL
// target. Anything else is refused and logged; a non-PDF is never handed to
// shell.openPath, which would execute it.
function isUnder(root, p) {
  const r = path.resolve(root).replace(/[\\/]+$/, "").toLowerCase() + path.sep;
  return p.toLowerCase().startsWith(r);
}

async function openLocalPdf(rawPath, allowedRoots, log) {
  const note = (line) => {
    try {
      if (log) log(line);
    } catch (e) {
      /* logging must never throw */
    }
  };
  const refuse = (why) => {
    note(`REFUSED ${JSON.stringify(String(rawPath)).slice(0, 400)}: ${why}`);
    return { ok: false, error: why };
  };
  if (typeof rawPath !== "string" || !rawPath || rawPath.length > 1000) return refuse("not a path");
  const s = rawPath.trim();
  if (!/^[A-Za-z]:[\\/]/.test(s)) return refuse("not an absolute drive-letter path");
  if (s.indexOf(":", 2) !== -1) return refuse("colon after the drive letter (stream or device syntax)");
  if (/[\0<>"|?*]/.test(s)) return refuse("illegal characters in path");
  const resolved = path.resolve(s);
  if (!/\.pdf$/i.test(resolved)) return refuse("not a .pdf");
  const roots = (allowedRoots || []).filter(Boolean);
  if (!roots.some((r) => isUnder(r, resolved))) return refuse("outside the allowed folders");
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (e) {
    return refuse("file does not exist");
  }
  if (!/\.pdf$/i.test(real)) return refuse("real target is not a .pdf");
  if (!roots.some((r) => isUnder(r, real))) return refuse("real target is outside the allowed folders");
  let st;
  try {
    st = fs.statSync(real);
  } catch (e) {
    return refuse("file does not exist");
  }
  if (!st.isFile()) return refuse("not a regular file");
  const err = await shell.openPath(real); // "" on success
  if (err) return refuse("openPath failed: " + err);
  note(`OPENED ${real}`);
  return { ok: true };
}

module.exports = { listRegistry, registryAction, openLocalPdf };

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

module.exports = { listRegistry, registryAction };

// v1.76.0: runs archive.js getUsageWindows() off the main thread.
//
// The account-wide usage scan walks every transcript of every project under
// ~/.claude/projects (3+ GB on Iddo's PC). Incremental since v1.22.2, but its
// first call after launch still read all of it on the Electron main thread -
// 21 s measured on 2026-10-06, during which every IPC call (agent list, chat
// load, clicks) waited. Here the scan runs in a worker thread, with its own
// copy of archive.js and its own per-file record cache, which it also saves to
// disk (`cacheFile`) so the next launch starts warm. main.js falls back to the
// main-thread call if this worker cannot be started.
const { parentPort, workerData } = require("worker_threads");
const archive = require("./archive");

const cacheFile = workerData && workerData.cacheFile;
const SAVE_EVERY_MS = 60 * 1000;
let lastSaveAt = 0;
let loaded = 0;
if (cacheFile) {
  try { loaded = archive.loadUsageFileCache(cacheFile); } catch (e) { loaded = 0; }
}

parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "get-usage-windows") return;
  const t0 = Date.now();
  let result = null;
  let error = null;
  try {
    result = archive.getUsageWindows();
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  parentPort.postMessage({ id: msg.id, result, error, ms: Date.now() - t0, loaded });
  if (cacheFile && archive.isUsageFileCacheDirty() && Date.now() - lastSaveAt > SAVE_EVERY_MS) {
    lastSaveAt = Date.now();
    try { archive.saveUsageFileCache(cacheFile); } catch (e) { /* diagnostics only; the next launch scans cold */ }
  }
});

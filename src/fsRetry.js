// Shared retry helper for filesystem writes in this project's Dropbox-synced
// tree. Confirmed live (2026-08-20, see agent-desktop\CLAUDE.md, "New
// capability: Claude can now directly drive Agent Desktop itself") that
// something real - not yet identified for certain, Windows Defender's
// real-time scanning racing the Dropbox sync client over the same new file
// is the leading suspect - transiently locks freshly-created/modified files
// in this folder for a couple of seconds. Confirmed to throw ENOENT (a temp
// file disappearing mid-write), not just the EBUSY/EPERM/EACCES set this
// project's one prior retry helper (deleteAgentWithRetry in main.js) already
// checked for - that helper only ever covered deletes; every other write in
// this codebase (agent create/update, archive sync) had zero protection
// against the exact same class of failure.
const TRANSIENT_FS_ERROR_RE = /^(EBUSY|EPERM|EACCES|ENOENT)$/;

// Wraps a synchronous function that does filesystem writes. Retries only on
// the specific transient error codes above - anything else (a genuine
// permission problem, a bad path, disk full) rethrows immediately on the
// first attempt, since retrying those would just waste time on an error
// that's never going to resolve itself.
function withFsRetry(fn, { attempts = 5, delayMs = 400 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      if (i === attempts - 1 || !TRANSIENT_FS_ERROR_RE.test(e.code)) throw e;
      // Synchronous sleep - deliberate. The callers here (agent create/
      // update, archive sync) already run on Electron's main process off
      // the direct render path (IPC handlers, a 30s background timer), not
      // inside a tight UI loop, so blocking briefly is an acceptable trade
      // for keeping the call sites themselves synchronous and simple rather
      // than threading async/await through agents.js and archive.js just
      // for this.
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        /* busy-wait */
      }
    }
  }
  throw lastError;
}


// Async variant for call sites that are already async (e.g. IPC handlers
// awaiting a delay) - shares the same transient-error detection so both
// forms of retry logic in this app agree on exactly what counts as
// "worth retrying" in one place, rather than two regexes that could drift.
async function withFsRetryAsync(fn, { attempts = 5, delayMs = 400 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i === attempts - 1 || !TRANSIENT_FS_ERROR_RE.test(e.code)) throw e;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
module.exports = { withFsRetry, withFsRetryAsync, TRANSIENT_FS_ERROR_RE };

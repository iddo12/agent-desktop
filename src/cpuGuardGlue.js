// CPU guard wiring for main.js (v1.66.0): the start limiter, the one-time consent + install of the separate
// guard task, the banner state and its IPC. main.js only calls init() and limiter.acquire(); the logic lives in
// startLimiter.js and cpuGuardInstall.js (both unit-tested). Nothing here runs in a timer faster than 10 s.

"use strict";

const path = require("path");
const { createStartLimiter, readHoldFile } = require("./startLimiter");
const guard = require("./cpuGuardInstall");

// Pure: what the banner should say. limiter = limiter.snapshot(), status = readStatusFile() (or null).
function computeBannerState(limiter, status, guardOn = true) {
  const fresh = !!(status && status.fresh);
  const boxed = fresh && Array.isArray(status.boxed) ? status.boxed : status && fresh && status.boxed ? [status.boxed] : [];
  const holdActive = !!(limiter && limiter.hold && limiter.hold.active);
  const queued = (limiter && limiter.queued) || 0;
  const names = (holdActive && limiter.hold.boxed && limiter.hold.boxed.length ? limiter.hold.boxed : boxed).filter(Boolean);
  if (holdActive) {
    return {
      show: true,
      kind: "hold",
      text: "The PC is overloaded. New agent starts are paused until the load drops" + (queued ? ` (${queued} waiting)` : "") + "." + (names.length ? " Slowed: " + names.join(", ") + "." : "") + " Running agents keep working.",
      queued,
      boxed: names,
      guardOn,
    };
  }
  if (boxed.length) {
    return { show: true, kind: "overload", text: "The PC is busy. The CPU guard is slowing down: " + boxed.join(", ") + ". Agents keep working, only slower.", queued, boxed, guardOn };
  }
  if (queued > 0) {
    const l = limiter;
    return { show: true, kind: "queue", text: `Starting agents gradually to keep the PC responsive: ${l.started} of ${l.total} started.`, queued, boxed: [], guardOn };
  }
  return { show: false, kind: "none", text: "", queued: 0, boxed: [], guardOn };
}

const CONSENT_TEXT =
  "Agent Desktop can install a small background helper, the CPU guard, that keeps your PC responsive when many agents work at the same time.\n\n" +
  "It lowers the priority of the agents (they keep working, only slower) when the CPU stays overloaded, and tells Agent Desktop to hold back new starts until the load drops. It never closes anything, needs no administrator rights and sends nothing anywhere.\n\n" +
  "It installs as a hidden per-user scheduled task (AgentDesktop_CpuGuard) with files under %APPDATA%\\agent-desktop\\cpuguard. You can remove it at any time.";

function init({ app, ipcMain, dialog, testMode, getMainWindow, readUiFlags, setUiFlag, log = () => {} }) {
  const stateDir = guard.defaultStateDir();
  const srcDir = path.join(__dirname, "..", "tools", "cpuguard");
  const holdFile = path.join(stateDir, "state", "fleet_hold.json");
  const flags = () => readUiFlags() || {};

  let lastSent = "";
  function push() {
    const win = getMainWindow && getMainWindow();
    const st = compute();
    const j = JSON.stringify(st);
    if (j === lastSent) return;
    lastSent = j;
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("cpuguard-state", st);
      } catch (e) {
        /* window going away */
      }
    }
  }
  function compute() {
    const f = flags();
    return computeBannerState(limiter.snapshot(), guard.readStatusFile(stateDir), f.cpuGuardEnabled !== false);
  }

  const limiter = createStartLimiter({
    readHold: () => readHoldFile(holdFile),
    enabled: () => flags().limiterEnabled !== false,
    log,
    onChange: () => push(),
  });

  // Banner refresh when nothing is queued (the guard can set a hold at any time): every 10 s, one small file read.
  let bannerTimer = null;
  function startBannerPoll() {
    if (bannerTimer || testMode.TEST_MODE) return;
    bannerTimer = setInterval(() => {
      limiter.refreshHold();
      push();
    }, 10000);
    if (bannerTimer.unref) bannerTimer.unref();
  }

  async function askConsent() {
    const win = getMainWindow && getMainWindow();
    const opts = {
      type: "question",
      title: "CPU guard",
      message: "Install the CPU guard?",
      detail: CONSENT_TEXT,
      buttons: ["Install", "Not now"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  }

  // Called once after startup. Returns what happened (see decideEnsure).
  async function ensure() {
    startBannerPoll();
    if (testMode.TEST_MODE || process.platform !== "win32") return { action: "none" };
    try {
      return await guard.ensureCpuGuard({ srcDir, stateDir, platform: process.platform, testMode: testMode.TEST_MODE, getFlags: flags, setFlag: setUiFlag, askConsent, log });
    } catch (e) {
      log(`cpuguard: ensure failed: ${e.message}`);
      return { action: "none", error: e.message };
    }
  }

  ipcMain.handle("cpuguard-state", async () => ({ banner: compute(), guard: await guard.getCpuGuardStatus({ stateDir, getFlags: flags, srcDir }) }));
  ipcMain.handle("cpuguard-action", async (event, { action } = {}) => {
    if (testMode.TEST_MODE || process.platform !== "win32") return { ok: false, error: "not available here" };
    if (action === "disable") {
      setUiFlag("cpuGuardEnabled", false);
      await guard.stopGuard(guard.TASK_NAME, stateDir);
      await guard.setTaskEnabled(guard.TASK_NAME, false);
      return { ok: true };
    }
    if (action === "enable") {
      setUiFlag("cpuGuardEnabled", true);
      setUiFlag("cpuGuardConsent", "yes");
      await guard.setTaskEnabled(guard.TASK_NAME, true);
      const r = await ensure();
      return { ok: true, result: r.action };
    }
    if (action === "uninstall") {
      await guard.uninstallGuard(guard.TASK_NAME, stateDir);
      setUiFlag("cpuGuardEnabled", false);
      setUiFlag("cpuGuardConsent", "no");
      return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  });

  return { limiter, ensure, compute, push };
}

module.exports = { init, computeBannerState, CONSENT_TEXT };

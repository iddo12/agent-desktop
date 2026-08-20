const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const pty = require("node-pty");
const { listAgents, createAgent, updateAgent, deleteAgent } = require("./agents");
const { syncArchive, listArchivedDays, readArchivedDay, encodeProjectPath, getLatestUsage, getUsageWindows, getLiveTranscriptBlocks } = require("./archive");
const { withFsRetryAsync } = require("./fsRetry");

let mainWindow;
const ptySessions = new Map(); // agentPath -> { proc, sessionCwd, archiveTimer }

// node-pty (unlike child_process) does not do PATH lookup on Windows - it needs
// the fully resolved executable path. Deliberately does NOT use fs.existsSync/
// statSync/readdirSync to validate the path first: in this app's launch context
// (via the hidden VBS wrapper), those calls reproducibly report ENOENT for a
// file independently confirmed to exist on disk three separate ways - a real,
// unexplained quirk isolated to Node's fs module in this specific process, not
// an actual missing-file condition. node-pty's own spawn uses a different,
// lower-level Windows API path than fs does, so it's used directly here without
// a broken pre-check gate; if the path is genuinely wrong, spawn itself will
// fail with its own clear error instead.
function resolveClaudeExecutable() {
  try {
    const found = execSync("where claude.cmd", { encoding: "utf-8" }).split("\n")[0].trim();
    if (found) return found;
  } catch (e) {
    /* PATH lookup unavailable in this process's environment - fall back below */
  }
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, "npm", "claude.cmd");
  }
  throw new Error("Could not resolve claude.cmd - not on PATH and APPDATA is unset");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Agent Desktop",
    backgroundColor: "#0f1115",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron throttles renderer JS timers (setTimeout/setInterval,
      // including the debounce that schedules live chat-view rebuilds) once
      // this window loses focus, to save resources. Confirmed to actually
      // bite: a response landed while the window wasn't focused, and the
      // chat view stayed stuck showing nothing until opening DevTools
      // (which refocuses the window) let the stalled rebuild finally fire.
      // This app needs to keep rendering correctly even when it's not the
      // focused window (e.g. the user working in another app while a response
      // comes in), so that throttling is disabled entirely rather than
      // worked around.
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Without this, launching the app a second time (e.g. clicking the shortcut
// again while an earlier window is still alive somewhere, minimized, or not
// fully closed) spawns a completely separate process with its own empty
// ptySessions map - confirmed to actually happen: the visible new window's
// terminal was blank while an old, invisible instance from hours earlier was
// still silently answering messages in the background the whole time. A
// single-instance lock makes a second launch just refocus the real window
// instead of creating that split-brain situation.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
}

app.on("window-all-closed", () => {
  for (const [agentPath, session] of ptySessions) {
    try {
      clearInterval(session.archiveTimer);
      syncArchive(agentPath, session.sessionCwd);
      session.proc.kill();
    } catch (e) {}
  }
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------- agents --

ipcMain.handle("list-agents", () => listAgents());

ipcMain.handle("pick-avatar", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose an avatar image",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  return {
    path: filePath,
    dataUrl: `data:image/${path.extname(filePath).slice(1)};base64,${buffer.toString("base64")}`,
  };
});

ipcMain.handle("create-agent", (event, { name, role, avatarPath }) => {
  let avatarBuffer = null;
  if (avatarPath && fs.existsSync(avatarPath)) {
    avatarBuffer = fs.readFileSync(avatarPath);
  }
  const agentDir = createAgent({ name, role, avatarBuffer });
  return { agentDir };
});

ipcMain.handle("update-agent", (event, { agentPath, name, role, avatarPath }) => {
  let avatarBuffer = null;
  if (avatarPath && fs.existsSync(avatarPath)) {
    avatarBuffer = fs.readFileSync(avatarPath);
  }
  updateAgent(agentPath, { name, role, avatarBuffer });
  return { ok: true };
});

// Windows does not release a killed process file handles (including its
// own working-directory lock) the instant kill() is called - confirmed to
// actually bite: deleting an agent right after killing its live session
// failed with "EBUSY: resource busy or locked, rmdir ...". Retries with a
// short backoff also guard against any other transient locker - a cloud
// sync tool, a security/AV scanner, whatever else might briefly hold a
// handle on this same folder - not just this specific pty-teardown race.
// Routed through the shared fsRetry.js
// helper (2026-08-20) so this uses the same transient-error set as the rest
// of the app file writes - the old inline check here tested e.message
// against /EBUSY|EPERM|EACCES/ and never matched ENOENT, despite ENOENT
// being live-confirmed (same session) as a real, reproducible transient
// error in this exact project folder.
async function deleteAgentWithRetry(agentPath, attempts = 5, delayMs = 400) {
  await withFsRetryAsync(() => deleteAgent(agentPath), { attempts, delayMs });
}

ipcMain.handle("delete-agent", async (event, { agentPath }) => {
  // Kill any live session for this agent first - deleting its folder out
  // from under a running pty (its cwd, its archive target) would otherwise
  // leave an orphaned process and a broken syncArchive call on its next tick.
  const session = ptySessions.get(agentPath);
  if (session) {
    try {
      clearInterval(session.archiveTimer);
    } catch (e) {}
    ptySessions.delete(agentPath);
    // Wait for the process to actually confirm it's gone (with a timeout
    // fallback in case exit never fires) rather than assuming kill() is
    // instantaneous - this is the actual root cause of the EBUSY above.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        session.proc.onExit(finish);
        session.proc.kill();
      } catch (e) {
        finish();
      }
      setTimeout(finish, 2000);
    });
  }
  await deleteAgentWithRetry(agentPath);
  return { ok: true };
});

// A pasted clipboard image (as opposed to a dragged real file) has no
// filesystem path at all - it only exists as raw bytes in the clipboard.
// Claude Code's own Read tool needs an actual file to open, so a pasted
// image gets written out here as a real file before its path is ever
// mentioned to the agent. Saved to the OS temp dir (not the agent's own
// folder) since these are throwaway - nothing about them needs to persist
// or sync via Dropbox once the message referencing them has been sent.
const PASTED_IMAGE_DIR = path.join(app.getPath("temp"), "agent-desktop-pasted");

ipcMain.handle("save-pasted-image", (event, { base64, ext }) => {
  fs.mkdirSync(PASTED_IMAGE_DIR, { recursive: true });
  const filePath = path.join(PASTED_IMAGE_DIR, `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
});

// -------------------------------------------------------------- terminal --

// Claude Code keys sessions purely by working directory. Spawning directly in
// the agent's own folder would mean this app's sessions collide with (and get
// silently hijacked by) any other Claude Code session someone runs with that
// same folder as cwd - not a one-time risk, an ongoing one every time either
// gets used. A dedicated hidden subfolder gives Agent Desktop's sessions their
// own isolated project bucket in ~/.claude/projects/, while CLAUDE.md still
// loads normally since Claude Code searches parent directories for it.
const SESSION_CWD_DIRNAME = ".claude-session";
function sessionCwdFor(agentPath) {
  const dir = path.join(agentPath, SESSION_CWD_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hasPriorSession(cwd) {
  const projectDir = path.join(require("os").homedir(), ".claude", "projects", encodeProjectPath(cwd));
  try {
    return fs.readdirSync(projectDir).some((f) => f.endsWith(".jsonl"));
  } catch (e) {
    return false; // project dir doesn't exist yet - first-ever session for this cwd
  }
}

const ARCHIVE_SYNC_INTERVAL_MS = 30000;

// Shared by proc.onExit() below (the normal path) and the terminal-input/
// terminal-resize catch blocks further down (the "we only found out the
// process was dead because touching it just threw" path) - factored out so
// a dead process gets cleaned up and the renderer notified immediately on
// whichever signal arrives first, rather than only reacting to onExit and
// potentially sitting silent (no crash, but also no "[session ended]"
// notice) if onExit is ever slow to fire relative to a failed write/resize.
// Safe to call twice for the same agentPath - ptySessions.delete() makes
// the second call's ptySessions.get() return undefined and no-op.
function handlePtyExit(agentPath) {
  const session = ptySessions.get(agentPath);
  if (!session) return;
  clearInterval(session.archiveTimer);
  try {
    syncArchive(agentPath, session.sessionCwd);
  } catch (e) {}
  ptySessions.delete(agentPath);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal-exit", { agentPath });
  }
}

ipcMain.handle("start-terminal", (event, { agentPath, cols, rows }) => {
  if (ptySessions.has(agentPath)) {
    return { alreadyRunning: true };
  }

  // --continue resumes this agent's most recent conversation in its own folder,
  // so reopening an agent's chat picks up where you left off. Only passed when
  // a prior session actually exists though - Claude Code exits immediately with
  // "No conversation found to continue" rather than falling back to a fresh
  // session when there's nothing to resume, which would otherwise skip the
  // fresh-session CLAUDE.md handoff read entirely on an agent's very first open.
  const sessionCwd = sessionCwdFor(agentPath);
  const args = hasPriorSession(sessionCwd) ? ["--continue"] : [];
  const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
  const proc = pty.spawn(shell, args, {
    name: "xterm-color",
    cols: cols || 80,
    rows: rows || 30,
    cwd: sessionCwd,
    // Each agent here is a real, long-lived, user-facing session - not a
    // disposable nested call - but Agent Desktop's own process already
    // carries CLAUDE_CODE_CHILD_SESSION=1 (inherited from however it was
    // itself launched), and Claude Code's CLI silently turns off transcript
    // persistence for any child session by default, to avoid polluting
    // --resume/--continue history from throwaway nested calls. Without this
    // override, an agent can do real, visible work (confirmed live: a full
    // auto-triggered /compact) that never gets written to its own JSONL
    // transcript at all - the exact cause of the "Chat View shows nothing
    // even though Raw Terminal shows real activity" blind spot documented
    // elsewhere in this file. Confirmed 2026-08-20 (only discovered because
    // an old/large Testing agent session's own CLI printed the fix inline:
    // "restart with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE...").
    env: { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" },
  });

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", { agentPath, data });
    }
  });

  // Synced from Claude Code's own structured JSONL transcript, not the raw
  // terminal stream - periodically while the session runs (so long sessions
  // are progressively archived, not lost on a crash) and once more on exit.
  const archiveTimer = setInterval(() => {
    try {
      syncArchive(agentPath, sessionCwd);
    } catch (e) {}
  }, ARCHIVE_SYNC_INTERVAL_MS);

  proc.onExit(() => handlePtyExit(agentPath));

  ptySessions.set(agentPath, { proc, sessionCwd, archiveTimer });
  return { alreadyRunning: false };
});

ipcMain.handle("list-archived-days", (event, { agentPath }) => {
  const session = ptySessions.get(agentPath);
  if (session) {
    try {
      syncArchive(agentPath, session.sessionCwd);
    } catch (e) {}
  }
  return listArchivedDays(agentPath);
});

ipcMain.handle("read-archived-day", (event, { agentPath, dateKey }) => readArchivedDay(agentPath, dateKey));

ipcMain.handle("get-context-usage", (event, { agentPath }) => getLatestUsage(sessionCwdFor(agentPath)));

ipcMain.handle("get-live-transcript", (event, { agentPath }) => getLiveTranscriptBlocks(sessionCwdFor(agentPath)));

ipcMain.handle("get-usage-windows", () => getUsageWindows());

// Caught live (2026-08-20): a real crash, not a hang. If the underlying
// claude process has already died on its own (crashed, or one of the
// documented Claude Code Windows CLI hangs), the pty object can still sit
// in ptySessions until proc.onExit() gets around to cleaning it up -
// node-pty's own internal "exited" state can flip slightly before that JS
// callback actually fires, leaving a real, if narrow, race window. A
// resize or write landing in that window throws synchronously
// ("Cannot resize a pty that has already exited"), uncaught, which crashes
// the entire Electron main process with a blocking error dialog - looking
// exactly like "nothing is responding" when what actually happened is the
// process died and touching its corpse crashed the app.
//
// Catching alone isn't enough, found the same day: it stops the crash but
// leaves a second gap - if onExit is ever slow to fire relative to this
// failed write/resize (observed live: a Reset Session click went out to an
// already-dead process, produced no crash, but also never showed the
// "[session ended]" notice for several minutes), the session just sits
// silent with no crash *and* no signal, which is exactly the confusing
// "is it stuck or not" state this whole night was about. So this calls
// handlePtyExit() proactively the moment a write/resize proves the process
// is dead, instead of passively waiting on onExit alone - whichever signal
// arrives first wins, and calling it twice is safe (see its own comment).
ipcMain.on("terminal-input", (event, { agentPath, data }) => {
  const session = ptySessions.get(agentPath);
  if (session) {
    try {
      session.proc.write(data);
    } catch (e) {
      handlePtyExit(agentPath);
    }
  }
});

ipcMain.on("terminal-resize", (event, { agentPath, cols, rows }) => {
  const session = ptySessions.get(agentPath);
  if (session) {
    try {
      session.proc.resize(cols, rows);
    } catch (e) {
      handlePtyExit(agentPath);
    }
  }
});

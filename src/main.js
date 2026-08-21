const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
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

// npm itself lives alongside node.exe (wherever Node.js was installed), not
// in the same folder as globally-installed packages like claude.cmd above -
// same PATH-lookup-then-hardcoded-fallback pattern, since `where` can fail
// silently in this app's own launch context the same way it does for
// claude.cmd. `C:\Program Files\nodejs\npm.cmd` is the standard default
// location for a Windows Node.js install (confirmed on this machine).
function resolveNpmExecutable() {
  try {
    const found = execSync("where npm.cmd", { encoding: "utf-8" }).split("\n")[0].trim();
    if (found) return found;
  } catch (e) {
    /* PATH lookup unavailable in this process's environment - fall back below */
  }
  return "C:\\Program Files\\nodejs\\npm.cmd";
}

// ---------------------------------------------------- Claude Code updates --
//
// Agent Desktop depends on a completely separate Claude Code CLI install
// from the one the Claude Desktop app itself bundles/updates (confirmed
// directly, live: two independent `claude.exe` installs on this machine,
// different versions, different update mechanisms). resolveClaudeExecutable()
// above always resolves to the npm-global one - this section checks whether
// *that specific* install is behind the latest published version, and can
// update it, since nothing else on this machine does that automatically.

// The installed version is read directly from the package's own
// package.json rather than via `claude --version` - no process spawn
// needed at all for a simple version string, and avoids relying on
// child_process/pty exec just to answer this one question.
function getInstalledClaudeCodeVersion() {
  try {
    const claudeCmdPath = resolveClaudeExecutable();
    const pkgPath = path.join(path.dirname(claudeCmdPath), "node_modules", "@anthropic-ai", "claude-code", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || null;
  } catch (e) {
    return null;
  }
}

// Queries the npm registry directly over HTTPS rather than shelling out to
// `npm view` - a plain network request needs neither child_process (proven
// unreliable in this app's launch context) nor node-pty, and is simpler for
// a read-only version check than spawning a CLI process either way.
function getLatestClaudeCodeVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
      { headers: { "User-Agent": "agent-desktop" }, timeout: 8000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body).version || null);
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Plain numeric x.y.z comparison - both versions here always come from real
// npm-published semver (package.json / the registry's own "latest" tag), so
// this doesn't need to handle prerelease tags or other semver edge cases.
function isVersionNewer(latest, current) {
  if (!latest || !current) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

ipcMain.handle("check-claude-code-update", async () => {
  const current = getInstalledClaudeCodeVersion();
  const latest = await getLatestClaudeCodeVersion();
  return { current, latest, updateAvailable: isVersionNewer(latest, current) };
});

ipcMain.handle("update-claude-code", async () => {
  const npmPath = process.platform === "win32" ? resolveNpmExecutable() : "npm";
  // Routed through the same pty-based runner as the native-agent backend
  // calls below rather than child_process directly, for the same reason:
  // execFileSync/spawnSync are confirmed unreliable in this app's launch
  // context on Windows.
  await runClaudeCommand(npmPath, ["install", "-g", "@anthropic-ai/claude-code@latest"], { env: process.env });
  const current = getInstalledClaudeCodeVersion();
  return { current };
});

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
// 2026-08-21: widened from 5x400ms (2s total) to 12x500ms (6s total) - a
// native background agent's dispatch also spawns a separate, longer-lived
// "daemon" helper process (confirmed directly, live: `claude daemon run
// --origin transient --spawned-by {...cwd...}`) that `claude stop <id>`
// does not necessarily terminate promptly. It still holds its own handle
// on this same folder, so even after stopBackgroundAgentForCwd above has
// confirmed the *agent* session itself has exited, rmdir can still hit a
// real "EBUSY: resource busy or locked" until that separate daemon process
// also finishes exiting and releases it - the original 2s budget (sized
// for the unrelated attach-pty-kill case elsewhere in this file) wasn't
// enough headroom for that.
async function deleteAgentWithRetry(agentPath, attempts = 12, delayMs = 500) {
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
  await stopBackgroundAgentForCwd(sessionCwdFor(agentPath));
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

// --- Native background-agent backend (2026-08-21) -------------------------
// Instead of directly owning each agent's `claude` process via a bare
// pty.spawn(), each agent is now dispatched as a real native Claude Code
// background agent (`claude --bg`) and the pty here just attaches to it
// (`claude attach <id>`) for the live view. Confirmed directly, live,
// before building this: `claude attach` streams real incremental pty
// output (not a static snapshot), and a background agent's process
// genuinely survives independent of whatever is currently attached to it -
// killing/losing the attach connection does not kill the underlying agent.
// This is what makes the auto-reattach in handlePtyExit() below safe and
// meaningful: if the *attach* connection dies (a real, separately-confirmed
// node-pty/ConPTY quirk on Windows - killing an attach pty can throw an
// uncaught "AttachConsole failed" from node-pty's own cleanup code) but the
// underlying agent is still alive, this reconnects silently instead of
// telling the user their session ended when it didn't.
//
// child_process's execFileSync/spawnSync turns out to be structurally
// unreliable in this app's own launch context (via the hidden VBS wrapper):
// confirmed directly, live, three escalating ways - "spawnSync ...\claude.cmd
// EINVAL" (a .cmd batch file isn't independently executable without cmd.exe
// to interpret it), then "spawnSync cmd.exe ENOENT" (bare-name PATH lookup
// failing), then "spawnSync C:\Windows\system32\cmd.exe ENOENT" even against
// that fully-qualified, unquestionably-real system path. That last one rules
// out a PATH or .cmd-shim problem - it's the same unexplained fs/spawn-layer
// quirk resolveClaudeExecutable()'s own comment above already documents for
// fs.existsSync in this exact process. node-pty's spawn uses a different,
// lower-level Windows API path and is unaffected - already relied on
// throughout this file for the actual attach pty - so one-shot CLI calls
// (agents/--bg/stop) are run through it too rather than child_process,
// collecting output until the process exits instead of returning it
// synchronously.
// node-pty's own native addon does a synchronous file-existence pre-check
// via a raw Win32 GetFileAttributesW call (see conpty.cc's file_exists()) -
// completely separate from Node's own fs module or child_process, before
// ever attempting the actual spawn. Confirmed directly, live, on Iddo's
// real machine through this app's real launch path (Launch.vbs) rather
// than this project's own Playwright-driven test harness (which never
// exercises that exact path, so a whole class of bugs specific to it went
// uncaught all night): it threw "File not found: C:\Users\...\claude.cmd"
// for a path independently confirmed to exist and work - `where`, a
// direct `ls`, and a direct `claude --version` invocation all succeeded
// immediately afterward. Same broad class of quirk resolveClaudeExecutable()'s
// own comment documents for fs.existsSync in this app's launch context,
// just surfacing inside node-pty's native code instead of Node's fs layer.
// Retried rather than fully explained, since the underlying OS-level cause
// isn't something this app's own code can diagnose further or fix at the
// source - only retried for this specific, known-transient error message,
// not any other spawn failure.
//
// 2026-08-21, widened from 4x300ms (~1s total) to 10x500ms (~5s total):
// the original short budget did NOT clear the error live on Iddo's real
// machine (same "File not found" surfaced to the user even with retries
// active), yet an isolated reproduction attempt using the exact same
// wscript.exe -> cmd.exe -> node -> pty.spawn(claude.cmd) chain Launch.vbs
// itself uses succeeded immediately, on the first try, no retry needed -
// so this either takes longer than ~1s to clear on whatever is actually
// happening, or is specific to being launched via Explorer.exe (a real
// double-click) rather than a script-launched child process, which
// wasn't (and couldn't easily be) replicated in that isolated test.
// Widening the budget is a cheap, safe hedge either way; if this still
// doesn't clear it, the cause is more likely the latter (Explorer-launch-
// specific), not simply "needs longer to retry."
function spawnPtyWithRetry(shell, args, options, attempts = 10, delayMs = 500) {
  return new Promise((resolve, reject) => {
    function attempt(i) {
      try {
        resolve(pty.spawn(shell, args, options));
      } catch (e) {
        if (i >= attempts - 1 || !/^File not found:/.test(e.message)) {
          reject(e);
          return;
        }
        setTimeout(() => attempt(i + 1), delayMs);
      }
    }
    attempt(0);
  });
}

async function runClaudeCommand(shell, args, options) {
  const proc = await spawnPtyWithRetry(shell, args, {
    name: "xterm-color",
    cols: 240,
    rows: 50,
    // node-pty's native binding turns an explicit `cwd: undefined` into
    // a real invalid path rather than defaulting sanely - confirmed
    // directly: callers that don't care about cwd (listing/stopping,
    // as opposed to dispatching) hit "Cannot create process, error
    // code: 267" (Windows ERROR_DIRECTORY) every time without this.
    cwd: options.cwd || process.cwd(),
    env: options.env,
  });
  return new Promise((resolve) => {
    let output = "";
    proc.onData((data) => {
      output += data;
    });
    proc.onExit(() => resolve(output));
  });
}

async function listBackgroundAgents(shell, spawnEnv) {
  try {
    const output = await runClaudeCommand(shell, ["agents", "--json", "--all"], { env: spawnEnv });
    return JSON.parse(output);
  } catch (e) {
    return [];
  }
}

// A background agent still has a "pid" field for as long as its OS process
// is alive, regardless of its turn-by-turn state (idle/blocked/done are all
// still-running states between turns - only stopped/failed entries drop the
// pid field). Checking for pid presence is more robust than enumerating
// state strings, which Anthropic could add more of later.
async function findAliveBackgroundAgent(shell, spawnEnv, sessionCwd) {
  const agents = await listBackgroundAgents(shell, spawnEnv);
  const target = path.resolve(sessionCwd);
  return agents.find((a) => a.kind === "background" && a.pid && path.resolve(a.cwd || "") === target);
}

// Dispatches a fresh background agent for this cwd and returns its id.
// --continue is passed whenever a prior session exists, same condition
// hasPriorSession() already used for the old direct-spawn path - --bg
// --continue with no prompt dispatches idle, "send a prompt to start",
// which matches this app's own "reopen an agent to an empty, ready-to-type
// box" UX exactly (confirmed directly before writing this).
async function dispatchBackgroundAgent(shell, spawnEnv, sessionCwd) {
  const args = hasPriorSession(sessionCwd) ? ["--bg", "--continue"] : ["--bg"];
  const output = await runClaudeCommand(shell, args, { cwd: sessionCwd, env: spawnEnv });
  // Real dispatch output (confirmed byte-for-byte via a live test dispatch):
  // "backgrounded \xC2\xB7 5467abbc (idle ...)" - a single U+00B7 MIDDLE DOT,
  // not a literal "." or multiple dots.
  const match = output.match(/backgrounded\s*·\s*([a-f0-9]+)/i);
  if (!match) {
    throw new Error("Could not parse background agent id from dispatch output: " + output);
  }
  return match[1];
}

async function findOrDispatchBackgroundAgent(shell, spawnEnv, sessionCwd) {
  const existing = await findAliveBackgroundAgent(shell, spawnEnv, sessionCwd);
  if (existing) return existing.id;
  return dispatchBackgroundAgent(shell, spawnEnv, sessionCwd);
}

// Deleting an Agent Desktop agent must also stop its real native background
// agent process, not just whatever attach pty happens to be viewing it right
// now - the two are decoupled by design (see the backend comment above), so
// closing/killing the attach alone leaves the underlying `claude --bg`
// process orphaned, still running against a cwd whose folder is about to be
// deleted out from under it. Looked up by cwd (not by a live ptySessions
// entry) so this also catches an agent that was dispatched in an earlier
// app run and never reattached in this one - ptySessions only knows about
// sessions opened since the app last started.
async function stopBackgroundAgentForCwd(sessionCwd) {
  async function attempt() {
    const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
    const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" };
    const agent = await findAliveBackgroundAgent(shell, spawnEnv, sessionCwd);
    if (agent) {
      await runClaudeCommand(shell, ["stop", agent.id], { env: spawnEnv });
      // `claude stop` returning just means the stop request was issued, not
      // that the target background process has actually exited and released
      // its own handles yet - its cwd IS this same sessionCwd, unlike the
      // "stop" command's own pty process. Confirmed directly, live: deleting
      // right after stop resolved hit "EBUSY: resource busy or locked,
      // rmdir ...\.claude-session" even after deleteAgentWithRetry's own
      // 2-second retry window - that process was still holding it. Polling
      // here for the pid to actually disappear (same alive-check used
      // everywhere else in this file) closes that gap properly instead of
      // just widening the existing retry window and hoping.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const stillAlive = await findAliveBackgroundAgent(shell, spawnEnv, sessionCwd);
        if (!stillAlive) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  try {
    // Confirmed directly, live: this whole sequence can occasionally hang
    // well past its own internal 3s poll budget (root cause not fully
    // pinned down - isolated outside the app, the same pty-based `claude
    // stop` call reliably completes in under 2s, so something about this
    // app's own concurrent process/env state is implicated, not the
    // mechanism itself). A hard outer timeout means a flaky stop-detection
    // can never block the delete indefinitely - deleteAgentWithRetry's own
    // EBUSY-retry loop right after this is the real safety net either way,
    // so falling through to it (agent possibly still alive) is strictly
    // better than the delete just hanging forever with no feedback.
    await Promise.race([attempt(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  } catch (e) {
    /* best-effort - a stray still-running background process is not worth failing the delete over */
  }
}
// --- end native background-agent backend helpers ---------------------------
// Shared by proc.onExit() below (the normal path) and the terminal-input/
// terminal-resize catch blocks further down (the "we only found out the
// process was dead because touching it just threw" path) - factored out so
// a dead process gets cleaned up and the renderer notified immediately on
// whichever signal arrives first, rather than only reacting to onExit and
// potentially sitting silent (no crash, but also no "[session ended]"
// notice) if onExit is ever slow to fire relative to a failed write/resize.
// Safe to call twice for the same agentPath - ptySessions.delete() makes
// the second call's ptySessions.get() return undefined and no-op.
//
// 2026-08-21: now checks whether the underlying background agent is still
// alive before declaring the session dead - see the native background-agent
// backend comment above. Attempts exactly one silent re-attach; if that
// itself fails or exits immediately, falls through to the normal notice
// rather than risking a retry loop.
async function handlePtyExit(agentPath, isReattachAttempt = false) {
  const session = ptySessions.get(agentPath);
  if (!session) return;
  // A "starting" placeholder (see start-terminal below) isn't a dead session
  // to tear down - it's one that hasn't finished being created yet. A write/
  // resize landing in that brief dispatch window would otherwise throw on
  // session.proc being undefined, land here, and delete the placeholder out
  // from under the in-flight startTerminalSession call that's about to fill
  // it in - producing a false "[session ended]" notice for a session that
  // never actually started. Nothing to clean up here; just drop the signal.
  if (session.starting) return;
  clearInterval(session.archiveTimer);
  try {
    syncArchive(agentPath, session.sessionCwd);
  } catch (e) {}
  ptySessions.delete(agentPath);

  if (!isReattachAttempt && session.shell && session.spawnEnv) {
    const stillAlive = await findAliveBackgroundAgent(session.shell, session.spawnEnv, session.sessionCwd);
    if (stillAlive) {
      try {
        await startTerminalSession(agentPath, session.sessionCwd, session.cols, session.rows, stillAlive.id, /* isReattach */ true);
        return; // reconnected silently, don't notify the renderer
      } catch (e) {
        /* fall through to the normal "session ended" notice below */
      }
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal-exit", { agentPath });
  }
}

// Core session-connection logic, shared by the start-terminal IPC handler
// (a fresh open) and handlePtyExit's own silent-reattach path above. When
// knownAgentId is omitted, finds or dispatches a background agent for this
// cwd first; when provided (the reattach path), skips straight to attaching
// since the caller already confirmed it's alive.
async function startTerminalSession(agentPath, sessionCwd, cols, rows, knownAgentId, isReattachAttempt = false) {
  const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
  // See the CLAUDE_CODE_FORCE_SESSION_PERSISTENCE comment further up this
  // file - same reasoning applies to background-dispatched agents.
  const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" };

  let agentId;
  try {
    agentId = knownAgentId || (await findOrDispatchBackgroundAgent(shell, spawnEnv, sessionCwd));
  } catch (e) {
    throw new Error("[find/dispatch stage] " + e.message);
  }

  let proc;
  try {
    proc = await spawnPtyWithRetry(shell, ["attach", agentId], {
      name: "xterm-color",
      cols: cols || 80,
      rows: rows || 30,
      cwd: sessionCwd,
      env: spawnEnv,
    });
  } catch (e) {
    throw new Error("[attach stage, agentId=" + agentId + "] " + e.message);
  }

  // Anything typed while this was still a "starting" placeholder (see the
  // terminal-input handler's own comment) needs replaying once the real
  // proc exists - but the pty object existing isn't the same as the actual
  // Claude Code process behind it being ready to read stdin. Confirmed
  // directly, live, twice: flushing right after pty.spawn() returns loses
  // the input every time, even staggered 80ms apart - the CLI is still mid-
  // boot (rendering its "Welcome back" banner takes real seconds) and isn't
  // listening yet, so the write lands before anything is there to read it.
  // Gating the flush on the pty's own output actually going quiet - the
  // same idle-detection renderer.js already uses (IDLE_TIMEOUT_MS there) to
  // know when a *running* session is done responding and ready for the next
  // message - reuses that same signal for "ready for the first message."
  const FLUSH_IDLE_MS = 900;
  const priorSession = ptySessions.get(agentPath);
  const pendingInput = priorSession && priorSession.pendingInput;
  let flushIdleTimer = null;

  function flushPendingInput() {
    if (!pendingInput || !pendingInput.length) return;
    // splice() both copies the queued items AND empties pendingInput in
    // place (it's a reference into the placeholder's own array) - without
    // this, the queue was never actually drained: proc.onData() below fires
    // again on the CLI's very next output chunk, and since a streaming
    // response has output gaps >= FLUSH_IDLE_MS constantly (between tokens,
    // around tool calls), the idle timer kept re-firing and replaying the
    // same already-sent input over and over. Confirmed directly, live: one
    // Enter press became 53 duplicate submissions of the same message
    // before this fix, visible as 53 near-identical entries in the
    // session's own JSONL transcript.
    const toSend = pendingInput.splice(0, pendingInput.length);
    toSend.forEach((data, i) => {
      // Still staggered, not blasted as one synchronous burst - see
      // submitToAgent() in renderer.js for why a composed message and its
      // trailing "\r" must land as two separately-timed writes.
      setTimeout(() => proc.write(data), i * 80);
    });
  }

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", { agentPath, data });
    }
    if (pendingInput && pendingInput.length) {
      clearTimeout(flushIdleTimer);
      flushIdleTimer = setTimeout(flushPendingInput, FLUSH_IDLE_MS);
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

  proc.onExit(() => {
    clearTimeout(flushIdleTimer);
    handlePtyExit(agentPath, isReattachAttempt);
  });

  ptySessions.set(agentPath, { proc, sessionCwd, archiveTimer, shell, spawnEnv, agentId, cols, rows });
}

ipcMain.handle("start-terminal", async (event, { agentPath, cols, rows }) => {
  if (ptySessions.has(agentPath)) {
    return { alreadyRunning: true };
  }
  // Dispatching is now async (see startTerminalSession below), so a second
  // start-terminal call for the same agent could otherwise race past this
  // has() check before the first call's real session lands, dispatching a
  // duplicate background agent for the same folder. Claiming the slot with
  // a placeholder synchronously, before any await, closes that window - the
  // real session object overwrites it once startTerminalSession finishes.
  ptySessions.set(agentPath, { starting: true, pendingInput: [] });

  // --continue resumes this agent's most recent conversation in its own folder,
  // so reopening an agent's chat picks up where you left off. Only passed when
  // a prior session actually exists though - Claude Code exits immediately with
  // "No conversation found to continue" rather than falling back to a fresh
  // session when there's nothing to resume, which would otherwise skip the
  // fresh-session CLAUDE.md handoff read entirely on an agent's very first open.
  // (dispatchBackgroundAgent() applies this same condition internally now.)
  const sessionCwd = sessionCwdFor(agentPath);
  try {
    await startTerminalSession(agentPath, sessionCwd, cols, rows);
  } catch (e) {
    ptySessions.delete(agentPath);
    throw e;
  }
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
  if (!session) return;
  // A "starting" placeholder has no real proc yet (background-agent dispatch
  // is async now - see start-terminal below). Confirmed directly, live: a
  // message sent right after opening an agent can land in this brief window
  // and, before this queue existed, was silently dropped - session.proc.write
  // threw on undefined, handlePtyExit() correctly no-op'd on the placeholder
  // (see its own comment) so there was no false "[session ended]" notice
  // either, but the typed message just vanished with zero feedback. Queuing
  // it here and flushing in startTerminalSession() once the real proc exists
  // fixes that without reintroducing the false-notice problem.
  if (session.starting) {
    session.pendingInput.push(data);
    return;
  }
  try {
    session.proc.write(data);
  } catch (e) {
    handlePtyExit(agentPath);
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

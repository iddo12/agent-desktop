const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { execSync, execFileSync } = require("child_process");
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
// Root-caused live, 2026-08-23, the actual explanation behind every earlier
// round of "File not found"/"is not recognized" theorized in this file
// (updater races, Defender, ConPTY quirks - all real contributing factors
// for OTHER incidents, but not the fundamental one): `%APPDATA%\npm\
// claude.cmd` is not an independent file at all - `Get-Item` reveals it's a
// reparse point (symlink) into Claude Desktop's own MSIX/UWP app-package
// storage (`%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\npm\
// claude.cmd`), created by Claude Desktop's own installer as a convenience
// shortcut. Confirmed directly, live, on Iddo's machine: at the exact same
// moment, `Test-Path` on the symlinked path returned `False` from a plain
// PowerShell window (and independently, from Agent Desktop's own process
// via the cmd-not-recognized.log diagnostics below), while `ls` from a
// bash session with Claude Desktop's own package trust context saw it
// fine, and `Test-Path` directly on the REAL target path (bypassing the
// symlink entirely) returned `True`. Windows' AppContainer-style access
// control for a packaged app's LocalCache folder is evidently NOT reliably
// resolvable through that reparse point from every process/security
// context - exactly the kind of intermittent, context-dependent failure
// that made this so hard to pin down across three earlier rounds of fixes.
// Fixed at the actual source: resolve the real target directly, skipping
// the symlink entirely, rather than continuing to retry through it.
function resolveClaudeExecutable() {
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE && path.join(process.env.USERPROFILE, "AppData", "Local"));
  if (localAppData) {
    try {
      const packagesDir = path.join(localAppData, "Packages");
      const claudePkg = fs.readdirSync(packagesDir).find((name) => name.startsWith("Claude_"));
      if (claudePkg) {
        const direct = path.join(packagesDir, claudePkg, "LocalCache", "Roaming", "npm", "claude.cmd");
        if (fs.existsSync(direct)) return direct;
      }
    } catch (e) {
      /* Claude Desktop's package folder isn't where expected - fall back below */
    }
  }
  // Fallback for a machine without Claude Desktop's packaged app (e.g. only
  // a plain npm-global install) - the original symlink-following resolution.
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

// npm-global claude.cmd calls out to plain `node` for various things, but
// this app's own launch context has repeatedly proven that bare-command PATH
// lookups (`where`, a bare `node`/`cmd` invocation via child_process) are not
// reliable here - same reasoning as resolveClaudeExecutable() above, same
// resolve-then-hardcoded-fallback pattern.
function resolveNodeExecutable() {
  try {
    const found = execSync("where node.exe", { encoding: "utf-8" }).split("\n")[0].trim();
    if (found) return found;
  } catch (e) {
    /* PATH lookup unavailable in this process's environment - fall back below */
  }
  return "C:\\Program Files\\nodejs\\node.exe";
}

// --------------------------------------------------- Rate-limit statusLine --
//
// Installs src/statusline.cjs as Iddo's global Claude Code statusLine, once,
// on first launch after this feature shipped - see that file's own comment
// for the full design (it both renders a real status line for any
// interactive `claude` session and feeds Agent Desktop's own rate-limit
// badges real, Anthropic-reported figures instead of the message-count
// heuristic archive.js otherwise has to fall back to). Deliberately
// idempotent and non-destructive: if Iddo (or a plugin) already has ANY
// statusLine configured, this leaves it completely alone rather than
// clobbering something he may have set up himself - the usage badges simply
// keep using the heuristic in that case, same as before this feature existed.
// Iddo caught a real bug 2026-08-23: the 7-day badge read 69% while
// Claude's own native app was already showing "Approaching weekly usage
// limit" - not a wrong figure, a STALE one. Without this, the cache only
// updates when an interactive session's own turn completes, which can
// leave it many minutes behind at exactly the moment it matters most (near
// the top of a window). refreshInterval is a real statusLine feature
// (confirmed against the official docs before using it) that re-runs the
// script on a fixed timer in addition to the normal event-driven updates.
const RATE_LIMIT_REFRESH_INTERVAL_SECONDS = 60;

function ensureRateLimitStatusLine() {
  const settingsPath = path.join(app.getPath("home"), ".claude", "settings.json");
  const ourScriptPath = path.join(__dirname, "statusline.cjs");
  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
    const existing = settings.statusLine;
    // Respect a genuinely different, user-configured statusLine untouched -
    // only ever install or upgrade our own. Detected by command containing
    // our own script's path (not just "does a statusLine exist"), so a
    // fresh install still upgrades an OLDER install of our own script
    // (e.g. one from before refreshInterval existed) rather than treating
    // it as "someone else's, leave it alone" forever.
    const isOurs = existing && existing.type === "command" && typeof existing.command === "string" && existing.command.includes(ourScriptPath);
    if (existing && !isOurs) return;

    const desired = {
      type: "command",
      command: `"${resolveNodeExecutable()}" "${ourScriptPath}"`,
      refreshInterval: RATE_LIMIT_REFRESH_INTERVAL_SECONDS,
    };
    if (isOurs && existing.command === desired.command && existing.refreshInterval === desired.refreshInterval) return;

    settings.statusLine = desired;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    // Non-critical - the usage badges just keep using the heuristic if this
    // never gets installed (e.g. ~/.claude/settings.json is malformed JSON
    // Iddo would want to know about some other way, not have silently
    // overwritten here).
  }
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

// Requested directly, after a driver-launched test instance and the
// user's own live instance showed different Claude Code update-available
// banners at the same time - confusing without a visible way to tell
// whether that's two different Agent Desktop builds or just two update
// checks that happened to run minutes apart (it was the latter). Electron's
// own app.getVersion() reads directly from package.json, so this always
// reflects whatever's actually installed/running, not a hardcoded string
// that could drift from the real version.
ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("check-claude-code-update", async () => {
  const current = getInstalledClaudeCodeVersion();
  const latest = await getLatestClaudeCodeVersion();
  return { current, latest, updateAvailable: isVersionNewer(latest, current) };
});

// Diagnosed live, 2026-08-23: clicking "Update" can report success while
// actually leaving the CLI broken. npm's own install process extracts the
// new version into a randomly-named staging folder, then renames it into
// place and deletes the old one - if any of the many claude.exe processes
// this app deliberately keeps alive as background agents happens to have
// a file handle open in that old folder at that exact moment, the delete
// step throws EPERM. npm treats this as a non-fatal warning ("npm warn
// cleanup...") and still exits 0 - but the rename into place can fail
// along with it, leaving the real package.json missing entirely at the
// resolved path while the old shim files got overwritten. The result:
// every future agent dispatch fails with a confusing "not recognized" -
// confirmed to have actually happened on Iddo's own machine, requiring a
// manual repair (copying a known-good install over the broken one) to fix.
async function updateClaudeCodeOnce(npmPath, shell) {
  await runClaudeCommand(npmPath, ["install", "-g", "@anthropic-ai/claude-code@latest"], { env: process.env });
  // Verify rather than trust npm's exit code - a real `claude --version`
  // run is the only thing that actually proves the install is usable.
  try {
    const output = await runClaudeCommand(shell, ["--version"], { env: process.env }, 3, 500);
    return /\(Claude Code\)/.test(output) || /^\d+\.\d+\.\d+/.test(output.trim());
  } catch (e) {
    return false;
  }
}

ipcMain.handle("update-claude-code", async () => {
  const npmPath = process.platform === "win32" ? resolveNpmExecutable() : "npm";
  const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
  // Routed through the same pty-based runner as the native-agent backend
  // calls below rather than child_process directly, for the same reason:
  // execFileSync/spawnSync are confirmed unreliable in this app's launch
  // context on Windows.
  let verified = await updateClaudeCodeOnce(npmPath, shell);
  // One retry - the same transient-file-lock hedge already used elsewhere
  // in this file (spawnPtyWithRetry, runClaudeCommand). A second attempt
  // gives whichever background agent process held the lock a chance to
  // have released it by the time this runs again.
  if (!verified) {
    verified = await updateClaudeCodeOnce(npmPath, shell);
  }
  const current = getInstalledClaudeCodeVersion();
  if (!verified || !current) {
    throw new Error(
      "The update ran, but the install couldn't be verified as working afterward - this can happen if a running " +
      "Claude Code process locked a file mid-update. The CLI may now be broken. Try closing every open agent, " +
      "fully closing and reopening Agent Desktop, then retrying the update."
    );
  }
  return { current };
});

// -------------------------------------------- known-interfering software --
//
// Diagnosed live, 2026-08-21/22, after a full day of chasing an
// intermittent "File not found" / "is not recognized as an internal or
// external command" error that only ever happened through this app's real
// launch path, never through any isolated reproduction: Process Monitor
// (kernel-level, cannot be fooled the way userspace checks can) caught
// Intel's "Energy Server Service" (esrv_svc.exe, part of Intel's SUR/
// System Usage Report telemetry bundle, services ESRV_SVC_QUEENCREEK and
// USER_ESRV_SVC_QUEENCREEK) making its own malformed CreateFile calls
// using the *exact* command line this app was trying to launch, at the
// *exact* moment each failure happened - it appears to hook process
// creation for its own telemetry purposes, and a bug in how it parses a
// multi-argument command line interferes with the real launch. This isn't
// specific to one machine's install - it's Intel driver-bundled software
// that could plausibly be present on any Windows machine this app runs
// on, so the check (and warning) belongs here, not just as a one-off fix
// on the machine it was found on.
const KNOWN_INTERFERING_SERVICES = [
  {
    serviceNames: ["ESRV_SVC_QUEENCREEK", "USER_ESRV_SVC_QUEENCREEK"],
    label: "Intel Energy Server Service (esrv_svc.exe)",
    explanation:
      "Part of Intel's SUR/telemetry bundle. Confirmed live (via Process Monitor) to intermittently interfere with launching the claude CLI, causing intermittent \"File not found\" / \"not recognized\" errors with no other visible cause. Not required for graphics, chipset, or any normal driver function - safe to disable.",
  },
];

async function checkInterferingServices() {
  if (process.platform !== "win32") return [];
  const found = [];
  for (const entry of KNOWN_INTERFERING_SERVICES) {
    for (const serviceName of entry.serviceNames) {
      try {
        const shell = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
        const output = await runClaudeCommand(
          shell,
          ["/d", "/c", "powershell", "-NoProfile", "-Command", `(Get-Service -Name ${serviceName} -ErrorAction SilentlyContinue).Status`],
          { env: process.env }
        );
        if (/Running/i.test(output)) {
          found.push({ ...entry, matchedServiceName: serviceName });
          break; // one hit for this entry is enough - don't list it twice for both service names
        }
      } catch (e) {
        /* best-effort - a failed check here shouldn't block the app from opening */
      }
    }
  }
  return found;
}

ipcMain.handle("check-interfering-services", () => checkInterferingServices());

// Stops and disables the service going forward - the app itself never
// silently gains admin rights to do this; Start-Process -Verb RunAs makes
// Windows show the user its own real UAC consent prompt for this one
// specific action, same as any other app requesting elevation.
ipcMain.handle("disable-interfering-service", async (event, { serviceName }) => {
  if (process.platform !== "win32") return { ok: false, error: "Not on Windows" };
  const found = KNOWN_INTERFERING_SERVICES.some((e) => e.serviceNames.includes(serviceName));
  if (!found) return { ok: false, error: "Unrecognized service name" };
  const psCommand = `Stop-Service -Name '${serviceName}' -Force -ErrorAction SilentlyContinue; Set-Service -Name '${serviceName}' -StartupType Disabled`;
  const encoded = Buffer.from(psCommand, "utf16le").toString("base64");
  try {
    // Same node-pty-routed pattern as everything else in this file -
    // child_process is the exact thing confirmed unreliable in this app's
    // launch context, and this whole feature exists because of an issue
    // that pattern helps sidestep, so using it here would be self-
    // defeating. Start-Process -Verb RunAs shows the user Windows' own
    // real UAC consent prompt for this one specific action - this app
    // itself never silently gains admin rights.
    const shell = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    await runClaudeCommand(
      shell,
      ["/d", "/c", "powershell", "-NoProfile", "-Command", `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-EncodedCommand','${encoded}' -Wait`],
      { env: process.env }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ------------------------------------- claude executable health check --
//
// Proactive startup check for "the 2 sec problem" (see CLAUDE.md's own
// top-of-file section by that name) and anything else that would produce
// the identical symptom - rather than waiting for Iddo to hit a cryptic
// mid-conversation failure and someone reverse-engineering it live (as
// happened once, at real length, on 2026-08-23), actually try running
// `claude --version` once at startup and surface a clear, specific banner
// immediately if it fails, instead of a per-agent "[failed to start
// session]" error that only shows up once you've already tried to use one.
async function checkClaudeExecutableHealth() {
  if (process.platform !== "win32") return { healthy: true };

  let resolvedPath;
  try {
    resolvedPath = resolveClaudeExecutable();
  } catch (e) {
    return { healthy: false, reason: "not-resolved", detail: e.message };
  }

  let viaSymlink = false;
  try {
    viaSymlink = fs.lstatSync(resolvedPath).isSymbolicLink();
  } catch (e) {
    /* not fatal - just means we can't report whether this specific path is a symlink */
  }

  if (!fs.existsSync(resolvedPath)) {
    return { healthy: false, reason: "missing", detail: resolvedPath, viaSymlink };
  }

  // A real, live smoke test - existence alone isn't sufficient proof it
  // actually runs, which is exactly what made "the 2 sec problem" so
  // confusing (the file existed the whole time, from most vantage points).
  // Deliberately a short retry budget here (not runClaudeCommand's usual
  // 20x900ms=~18s), so a genuine problem is reported within a few seconds
  // at startup rather than making every normal launch feel slow.
  try {
    const output = await runClaudeCommand(resolvedPath, ["--version"], { env: process.env }, 3, 500);
    if (CMD_NOT_RECOGNIZED_RE.test(output)) {
      return { healthy: false, reason: "not-recognized", detail: resolvedPath, viaSymlink };
    }
    return { healthy: true, resolvedPath, viaSymlink };
  } catch (e) {
    return { healthy: false, reason: "spawn-failed", detail: e.message, viaSymlink };
  }
}

ipcMain.handle("check-claude-executable-health", () => checkClaudeExecutableHealth());

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
  app.whenReady().then(() => {
    createWindow();
    ensureRateLimitStatusLine();
    reapOrphanedBackgroundAgentProcesses();
    setInterval(reapOrphanedBackgroundAgentProcesses, REAPER_INTERVAL_MS);
  });
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
// unreliable in this app's own launch context (via the hidden VBS wrapper) -
// confirmed directly, live: "spawnSync ...\claude.cmd EINVAL", "spawnSync
// cmd.exe ENOENT", and "spawnSync C:\Windows\system32\cmd.exe ENOENT" even
// against that fully-qualified, unquestionably-real system path. node-pty's
// spawn uses a different, lower-level Windows API path and is unaffected -
// already relied on throughout this file for the actual attach pty - so
// one-shot CLI calls (agents/--bg/stop) are run through it too rather than
// child_process, collecting output until the process exits instead of
// returning it synchronously.
//
// Two more layers of the same "this app's real launch chain behaves
// differently from any directly-launched process" problem, diagnosed live
// on 2026-08-21 and both worked around below:
//
// 1. node-pty's native Windows spawn path does its own file-existence
//    pre-check via raw GetFileAttributesW on the exact path *before*
//    attempting to launch it (see conpty.cc's file_exists()), and even
//    cmd.exe's own CreateProcess-level resolution failed the same way -
//    reproducibly, only through this app's real launch chain (WScript.Shell
//    -> hidden cmd.exe -> npm start -> electron.exe), never once through a
//    directly-launched process (Playwright, manual CLI, isolated scripts).
//    Ruled out directly: Electron's ASAR-patched fs (original-fs agrees),
//    a symlink/junction at the npm folder (fsutil confirms plain
//    directory), Windows Defender Controlled Folder Access (write-only, no
//    matching block event), and Malwarebytes malware/PUP scanning (folder
//    excluded, no change). What's left and specific to this app's own
//    spawning mechanism: node-pty defaults to the newer ConPTY backend on
//    Windows 10 1809+, which has known quirks with GUI-subsystem processes
//    (Electron.exe always is one) launched through a fully console-detached
//    chain like this one's hidden WScript.Shell.Run. Forcing the older
//    winpty backend (spawnOptions.useConpty = false below) sidesteps
//    ConPTY entirely and resolved it live.
// 2. Separately, `shell` here is a .cmd file, which node-pty can't spawn
//    directly on Windows without going through a real shell - toCmdShellSpawn
//    routes it through cmd.exe's own `/c` rather than the bare path.
function toCmdShellSpawn(shell, args) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(shell)) {
    return { shell, args };
  }
  const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  return { shell: comspec, args: ["/d", "/c", shell, ...args] };
}

function spawnPtyWithRetry(shell, args, options, attempts = 10, delayMs = 500) {
  return new Promise((resolve, reject) => {
    function attempt(i) {
      const { shell: spawnFile, args: spawnArgs } = toCmdShellSpawn(shell, args);
      const spawnOptions = process.platform === "win32" ? { ...options, useConpty: false } : options;
      try {
        const proc = pty.spawn(spawnFile, spawnArgs, spawnOptions);
        resolve(proc);
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

// Confirmed live, 2026-08-21: whatever intermittently makes this process
// unable to see the npm-global claude.cmd (see toCmdShellSpawn's comment
// above) doesn't always show up as node-pty's own synchronous spawn-time
// exception - cmd.exe can also launch fine itself and only fail *inside*
// its own run, printing its native "'<path>' is not recognized as an
// internal or external command..." to the pty's output stream instead of
// throwing. spawnPtyWithRetry's retry loop never sees that case (from its
// point of view, the spawn succeeded), so it was passing through as a
// silent bad result. Retrying the whole run (not just the spawn) whenever
// the output matches this exact failure signature closes that gap -
// confirmed non-deterministic (same code failed once, then succeeded
// immediately after on an unchanged retry), consistent with transient
// external interference rather than a real, permanent problem with the
// path.
const CMD_NOT_RECOGNIZED_RE = /is not recognized as an internal or external command/i;

// Diagnosed live, 2026-08-22, the actual root cause of the "File not
// found"/"is not recognized" errors above (the Intel esrv_svc.exe service
// documented near KNOWN_INTERFERING_SERVICES turned out to be a red
// herring - fully locked down there, and the bug still recurred). A full
// Process Monitor trace of a failing burst showed ten concurrent cmd.exe
// launches of claude.cmd all failing within the same ~6-second window, and
// in that same window `where.exe`'s own live directory listing of
// %APPDATA%\npm showed claude/claude.cmd/claude.ps1 and the whole
// node_modules\@anthropic-ai\claude-code folder genuinely absent from
// disk - not a permissions/AV illusion, an actual transient absence.
// %APPDATA%\npm\.last-update-result.json and a leftover
// .claude-code-<random> staging folder confirmed Claude Code's own
// npm-global self-updater had fired more than once recently, and that
// updater does an in-place swap of that entire shared global install
// (shims included) that takes several seconds. This app fires many
// concurrent claude.cmd invocations (one status poll per sidebar agent);
// any invocation whose launch lands inside that swap window sees the
// shims as literally gone. DISABLE_AUTOUPDATER=1 is a real,
// updater-respected env var - confirmed already set in Claude Desktop's
// own embedded Claude Code sessions - so setting it on every claude.cmd
// child process this app spawns stops the updater from ever firing out
// from under a concurrent launch, closing the race at its source rather
// than retrying around it. The explicit "update-claude-code" IPC handler
// above intentionally does NOT get this - that one IS the deliberate
// update path.
const CLAUDE_AUTOUPDATER_DISABLE_ENV = { DISABLE_AUTOUPDATER: "1" };

// Diagnosed live, 2026-08-22, a second and completely separate cause of an
// Agent Desktop session looking permanently frozen (the first being the
// updater race above): a background agent can get wedged mid-turn on an
// expired OAuth session - e.g. an auto-triggered /compact hitting "Login
// expired - Please run /login" - with no one there to complete the
// interactive browser login a headless process can't do itself. Caught
// live on a session that had been idle since the day before. Confirmed via
// Raw Terminal that the CLI's own elapsed-time spinner ("Sautéed for 50s")
// was genuinely static, not just slow, and that a brand new message sent
// through Agent Desktop's Chat View never even reached the underlying pty.
// findAliveBackgroundAgent only checks that the OS process still has a pid
// - it has no way to know the process inside is dead-ended on an
// unanswerable prompt - so every future attach, including this app's own
// silent reattach-on-restart in handlePtyExit, just reconnects to the same
// permanently stuck session forever. Confirmed directly: stopping that one
// dead session and dispatching a fresh `claude --bg` for the same cwd
// picked up a valid, working session immediately - the saved credentials
// themselves were fine, only that one already-running session was wedged.
const LOGIN_EXPIRED_RE = /Login expired|Not logged in.*Run \/login/is;
const LOGIN_EXPIRED_PEEK_MS = 1500;

// Diagnosed live, 2026-08-22, a third and completely separate cause of a
// session looking permanently frozen: Claude Code CLI's own --continue
// shows an interactive "how do you want to resume this" prompt whenever
// the target session is old/large enough ("This session is 2d 1h old and
// 127.2k tokens... We recommend resuming from a summary", with a 1/2/3
// menu and "Enter to confirm - Esc to cancel") - confirmed via
// `claude agents --json --all` showing this exact agent's status as
// "waiting"/waitingFor:"dialog open" the whole time it looked stuck, and
// via a raw pty peek showing the literal menu text sitting unanswered.
// Agent Desktop's Chat View has no way to detect or answer an interactive
// menu like this (it isn't a normal assistant turn), so the session just
// sits there forever with no error text at all - arguably a worse dead
// end than the login-expiry case above, since nothing in the UI even
// hints at what's wrong. Confirmed live: sending "3" (Don't ask me again)
// then Enter resolves it immediately into a normal, healthy session -
// reused verbatim here rather than "1" (resume from summary) since that's
// the exact sequence already proven to work, and it should also suppress
// this same prompt on future resumes of this session.
const RESUME_DIALOG_RE = /Resume from summary \(recommended\)/i;
const RESUME_DIALOG_PEEK_MS = 1500;

// Diagnosed live, 2026-08-21, the actual cause of messages appearing "sent"
// but never going anywhere: `output` here is captured straight off a real
// ConPTY - it's genuinely a terminal stream, not plain text, and comes
// full of terminal control codes (color/cursor-position/clear-screen CSI
// sequences, OSC window-title sequences, per-line erase-to-end-of-line
// redraw artifacts). dispatchBackgroundAgent()'s own id-extraction regex
// and listBackgroundAgents()'s JSON.parse() were both written and tested
// against clean text and silently broke once the real CLI's output
// started actually carrying these codes - dispatch regex fails closed
// (throws "Could not parse..."), so the subsequent attach that would give
// the user a live, working session never happens; JSON.parse() fails
// closed even more silently the OTHER way, via listBackgroundAgents()'s
// own catch-and-return-[] - meaning every open silently failed to find the
// agent it just dispatched, then dispatched ANOTHER new one instead of
// reusing it. Confirmed directly against a real captured multi-KB listing
// output: stripping these two families (OSC first, since an OSC sequence
// can itself contain characters a CSI-only strip would misparse) recovers
// clean, valid JSON every time. Centralized here (not at each call site)
// so every caller - present and future - gets clean text automatically.
function stripTerminalCodes(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC (window title, etc.)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""); // CSI (color/cursor/clear/erase)
}

async function runClaudeCommandOnce(shell, args, options) {
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
    proc.onExit(() => {
      resolve(stripTerminalCodes(output));
    });
  });
}

// Confirmed live, 2026-08-22: even with the updater-race fix above in
// place (DISABLE_AUTOUPDATER=1 genuinely active - checked the running
// process's own start time against this file's edit time to be sure), the
// exact same "is not recognized" text still recurred once, with the npm-
// global install's files completely unchanged before and after - no
// update swap in progress at the time. So the updater is a real, fixed
// cause of this symptom, but evidently not the only possible one; nothing
// else here has been caught as clearly as that one was. The previous
// 5-attempt/500ms budget (~2.5s) is what actually ran out here, per the
// user's own report of the failure appearing after "~2s" - raising this
// is a deliberately root-cause-agnostic hedge: whatever transient
// condition is briefly making a genuinely-present file unresolvable,
// giving it several more seconds to clear resolves it without needing to
// have pinned down every possible cause first.
// Log path for logCmdNotRecognized() below - deliberately NOT one of the
// "remove after the bug's confirmed fixed" temporary logs this file's own
// history mentions elsewhere. This failure class has now recurred (2026-08-
// 23, live, on Iddo's real machine) despite two earlier rounds that each
// looked like the real fix at the time (DISABLE_AUTOUPDATER, then the
// 5->12 attempt widening) - clear sign the root cause isn't actually
// understood yet, just mitigated. Keeping this logging permanently means
// the NEXT occurrence has real evidence to diagnose from instead of
// starting over from a screenshot and a guess.
const CMD_NOT_RECOGNIZED_LOG_PATH = path.join(app.getPath("userData"), "cmd-not-recognized.log");

function logCmdNotRecognized(attemptNum, shell) {
  try {
    let npmClaudeExists = "unknown";
    try {
      npmClaudeExists = String(fs.existsSync(shell));
    } catch (e) {}
    const line = `${new Date().toISOString()} attempt=${attemptNum} shell=${shell} existsOnDisk=${npmClaudeExists}\n`;
    fs.appendFileSync(CMD_NOT_RECOGNIZED_LOG_PATH, line);
  } catch (e) {
    // Logging itself must never be why a real attempt fails.
  }
}

// Widened again 2026-08-23 (12x700ms=8.4s -> 20x900ms=18s) after Iddo hit
// this exact hard failure live - "is not recognized" persisted across
// EVERY one of the previous 12 attempts, a full 8.4 seconds, meaning
// whatever transient condition this is can outlast that budget. Checked
// directly afterward: the npm-global install files were untouched for 21+
// hours (ruling out an in-progress auto-updater swap for THIS specific
// occurrence, despite that being the confirmed cause of an earlier round of
// this same symptom) and 8 back-to-back plain invocations of claude.cmd all
// succeeded normally minutes later - so whatever this was had already
// cleared by the time it could be inspected, consistent with something
// transient but NOT necessarily the same transient cause as before. Rather
// than chase an already-cleared window further, widened the budget (a
// blunt but proven-effective hedge for this exact failure class) and added
// logCmdNotRecognized() above so a future occurrence leaves real evidence -
// specifically, whether the file existed on disk at the moment of failure -
// instead of requiring another live-reproduction hunt.
async function runClaudeCommand(shell, args, options, attempts = 20, delayMs = 900) {
  for (let i = 0; i < attempts; i++) {
    const output = await runClaudeCommandOnce(shell, args, options);
    if (!CMD_NOT_RECOGNIZED_RE.test(output)) {
      return output;
    }
    logCmdNotRecognized(i, shell);
    if (i === attempts - 1) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
    const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", ...CLAUDE_AUTOUPDATER_DISABLE_ENV };
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

// Diagnosed live, 2026-08-23: a `claude --bg` dispatch's own "daemon run"
// helper process can die without ever cleaning up the "--bg-pty-host"
// wrapper (and that wrapper's own inner --session-id process) it spawned.
// Windows does not kill a process's children when it dies unless it
// explicitly used a Job Object, and nothing - not this app, not the CLI
// itself - ever re-checks these once dispatched. Confirmed live: 8 such
// orphaned pairs (16 processes, ~5GB of RAM) were found sitting idle for
// over an hour, every one with a dead parent daemon, none of them having
// ever written a single line to a transcript file - this matches, and now
// gives a confirmed mechanism for, the "several orphaned background agents
// accumulated" observation from the 2026-08-21 backend-rewrite investigation
// above, which was circumstantial at the time.
//
// A pty-host is only treated as orphaned - and only killed - when BOTH:
// (1) its own parent PID is no longer running, AND (2) `claude agents --json
// --all` does not list its session id as still known to the CLI. Either
// signal alone risks a false positive (a legitimately reparented process, or
// a momentary gap in `agents --json`); both together is the conservative bar
// for something to actually be unreachable dead weight worth killing.
//
// $ProgressPreference='SilentlyContinue' avoids a real, confirmed gotcha:
// Get-CimInstance's first-use module load writes a "Preparing modules..."
// progress record that PowerShell serializes as CLIXML onto the output
// stream when invoked non-interactively like this, corrupting the JSON.
function runPowerShellJson(script) {
  const wrapped = `$ProgressPreference='SilentlyContinue'; ${script}`;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  // execFileSync (argument array, no shell) rather than execSync (shell
  // string) - the -EncodedCommand payload is base64 so it can't contain
  // shell metacharacters either way, but this avoids a shell entirely
  // rather than relying on that being true forever.
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = out.trim() ? JSON.parse(out) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function listClaudeProcessesWindows() {
  try {
    return runPowerShellJson("Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress");
  } catch (e) {
    return [];
  }
}

// process.kill(pid, 0) throws ESRCH if the pid is gone, but throws EPERM
// (not ESRCH) if the pid exists and this process just lacks permission to
// signal it - EPERM therefore still means "alive," not "unreachable."
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const REAPER_LOG_PATH = path.join(app.getPath("userData"), "orphan-reaper.log");
function logReaperAction(line) {
  try {
    fs.appendFileSync(REAPER_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    /* logging itself must never be why the reaper fails */
  }
}

async function reapOrphanedBackgroundAgentProcesses() {
  if (process.platform !== "win32") return;
  try {
    const procs = listClaudeProcessesWindows();
    const pidsPresent = new Set(procs.map((p) => p.ProcessId));
    const ptyHosts = procs.filter((p) => (p.CommandLine || "").includes("--bg-pty-host"));
    if (ptyHosts.length === 0) return;

    const shell = resolveClaudeExecutable();
    const spawnEnv = { ...process.env, ...CLAUDE_AUTOUPDATER_DISABLE_ENV };
    const knownAgents = await listBackgroundAgents(shell, spawnEnv);
    const knownIds = new Set(knownAgents.map((a) => a.id));

    for (const host of ptyHosts) {
      const parentAlive = pidsPresent.has(host.ParentProcessId) || isPidAlive(host.ParentProcessId);
      if (parentAlive) continue; // still owned by a live daemon - leave it alone

      const idMatch = (host.CommandLine || "").match(/--session-id\s+([a-f0-9-]+)/i);
      const sessionId = idMatch ? idMatch[1] : null;
      if (sessionId && knownIds.has(sessionId)) continue; // CLI still knows it - don't touch it

      const children = procs.filter((p) => p.ParentProcessId === host.ProcessId);
      const toKill = [host.ProcessId, ...children.map((c) => c.ProcessId)];
      for (const pid of toKill) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (e) {
          /* already gone - fine */
        }
      }
      logReaperAction(`killed orphaned pty-host pid=${host.ProcessId} sessionId=${sessionId || "unknown"} deadParentPid=${host.ParentProcessId} children=[${children.map((c) => c.ProcessId).join(",")}]`);
    }
  } catch (e) {
    logReaperAction(`reaper error: ${e.message}`);
  }
}

// Run once at startup (catches orphans left over from a prior app run or
// crash) and then on a slow periodic sweep while the app stays open - this
// isn't chasing a fast-moving condition, a daemon dying mid-session is rare,
// so 30 minutes is plenty rather than adding startup-only blind spots for a
// long-running window.
const REAPER_INTERVAL_MS = 30 * 60 * 1000;
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
async function startTerminalSession(agentPath, sessionCwd, cols, rows, knownAgentId, isReattachAttempt = false, isLoginRecoveryAttempt = false) {
  const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
  // See the CLAUDE_CODE_FORCE_SESSION_PERSISTENCE comment further up this
  // file - same reasoning applies to background-dispatched agents.
  const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", ...CLAUDE_AUTOUPDATER_DISABLE_ENV };

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

  // See the LOGIN_EXPIRED_RE comment further up this file. Skipped on a
  // recovery attempt's own retry so a genuinely broken credential (not
  // just one stale session) can't loop forever redispatching new sessions
  // - if the fresh session hits the same wall, the user sees the real
  // "Not logged in" prompt directly instead of this silently retrying.
  if (!isLoginRecoveryAttempt) {
    let peekBuffer = "";
    let peekProcExited = false;
    const peekDataDisposable = proc.onData((d) => {
      peekBuffer += d;
    });
    const peekExitDisposable = proc.onExit(() => {
      peekProcExited = true;
    });
    await new Promise((resolve) => setTimeout(resolve, LOGIN_EXPIRED_PEEK_MS));
    peekDataDisposable.dispose();
    peekExitDisposable.dispose();

    if (LOGIN_EXPIRED_RE.test(stripTerminalCodes(peekBuffer))) {
      try {
        proc.kill();
      } catch (e) {}
      try {
        await runClaudeCommand(shell, ["stop", agentId], { env: spawnEnv });
      } catch (e) {}
      const freshAgentId = await dispatchBackgroundAgent(shell, spawnEnv, sessionCwd);
      return startTerminalSession(agentPath, sessionCwd, cols, rows, freshAgentId, isReattachAttempt, /* isLoginRecoveryAttempt */ true);
    }

    // See the RESUME_DIALOG_RE comment further up this file. Unlike the
    // login-expiry case, this doesn't need a fresh session - the existing
    // one just needs its already-open menu answered. Re-opens the data
    // listener (the peek one above was already disposed) to capture the
    // resumed session's own redraw so it isn't lost the same way the
    // pre-dialog output below is deliberately preserved.
    if (RESUME_DIALOG_RE.test(stripTerminalCodes(peekBuffer))) {
      let postDialogBuffer = "";
      const postDialogDisposable = proc.onData((d) => {
        postDialogBuffer += d;
      });
      proc.write("3");
      await new Promise((resolve) => setTimeout(resolve, 300));
      proc.write("\r");
      await new Promise((resolve) => setTimeout(resolve, RESUME_DIALOG_PEEK_MS));
      postDialogDisposable.dispose();
      peekBuffer += postDialogBuffer;
    }

    // node-pty's onExit doesn't fire retroactively for a listener attached
    // after the event already happened, so if the process died during our
    // own peek window (unrelated to the login-expiry check above), the
    // permanent proc.onExit() registered further down would never see it -
    // this session would sit in ptySessions as a phantom "still open"
    // placeholder forever, permanently blocking this agent from ever
    // starting again (start-terminal's own ptySessions.has() guard would
    // keep returning alreadyRunning for it). Throwing here instead routes
    // through the exact same, already-correct cleanup both of this
    // function's callers already have: start-terminal's IPC handler
    // deletes the placeholder and surfaces the error, and handlePtyExit's
    // own silent-reattach call falls through to its normal "[session
    // ended]" notice.
    if (peekProcExited) {
      throw new Error("[attach stage, agentId=" + agentId + "] process exited during startup");
    }
    // Nothing anomalous - forward what we buffered so the user doesn't
    // lose the first couple seconds of output (the "Welcome back" banner,
    // etc.) that arrived while we were peeking at it instead of streaming
    // it through live.
    if (peekBuffer && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", { agentPath, data: peekBuffer });
    }
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

  // Unconditionally arm one flush attempt up front, not just reactively
  // inside proc.onData() below. Found 2026-08-23 while investigating a
  // "message sent right after opening an agent just vanishes, no error, no
  // trace anywhere" report: anything typed during the login/resume-dialog
  // peek above (lines ~848-919) is already sitting in this same
  // pendingInput array by the time we get here, but the peek's own onData
  // listener was already disposed before this point - it never reaches the
  // one below. If this attach's entire redraw already happened during that
  // peek window (the common case for reattaching to an agent that's just
  // sitting idle with nothing new to draw), proc.onData() may never fire
  // again at all, so flushIdleTimer would never get armed and this input
  // would sit queued forever with zero feedback - never even reaching the
  // pty, so it never shows up in the CLI's own JSONL transcript either.
  // This timer covers that silent case; the onData-driven rearm below still
  // wins for a genuinely busy attach, pushing the flush out until real
  // output actually goes quiet instead of writing into a mid-redraw banner.
  if (pendingInput && pendingInput.length) {
    flushIdleTimer = setTimeout(flushPendingInput, FLUSH_IDLE_MS);
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

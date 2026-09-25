const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { execSync, execFileSync, execFile, spawn } = require("child_process");
const pty = require("node-pty");
const { listAgents, createAgent, updateAgent, deleteAgent, setAgentPaused, ROOT: AGENTS_ROOT } = require("./agents");
const { readGroups, writeGroups } = require("./groups");
const {
  syncArchive,
  listArchivedDays,
  readArchivedDay,
  encodeProjectPath,
  getLatestUsage,
  getUsageWindows,
  getLiveTranscriptBlocks,
  getSessionActivity,
  getLatestTranscriptMtimeMs,
  getHaltInfo,
  listConversations,
  setConversationTitle,
  repinAgentName,
} = require("./archive");
const { withFsRetryAsync } = require("./fsRetry");
const testMode = require("./testMode");
const overview = require("./overview");
const registry = require("./registry");
const argus = require("./argus-data");
const workspaceTrust = require("./workspaceTrust");
const appUpdate = require("./app-update");

// Must run before ANY app.getPath("userData") call, including the module-scope
// consts further down (UI_FLAGS_PATH, SENT_LOG_PATH, the watchdog logs) - they
// are evaluated at require time, so redirecting later would leave half this
// instance writing into the live instance's state.
if (testMode.TEST_MODE) {
  try {
    // A distinct AppUserModelID keeps Windows from grouping the sandbox under
    // the same taskbar button as the real app - without it the two share one
    // button and the amber icon never gets shown separately.
    app.setAppUserModelId("com.iddo.agentdesktop.sandbox");
    app.setPath("userData", path.join(app.getPath("appData"), "agent-desktop-test"));
  } catch (e) {
    // Better to refuse to start than to run a test instance that shares the
    // live one's logs, sent-message history and UI flags.
    throw new Error("Test mode could not redirect userData: " + e.message);
  }
}

// Deliberately leads with the distinguishing word rather than appending it.
// Iddo's note on seeing the first sandbox launch: "call it something else - it
// can be confusing". A title of "Agent Desktop - sandbox" is no help in a
// taskbar or an alt-tab list, where both instances truncate to "Agent
// Desktop...". Leading with SANDBOX survives truncation.
const SANDBOX_WINDOW_TITLE = "SANDBOX - Agent Desktop test copy (not your real agents)";

// Written on every startup so anyone (Claude, in practice) can answer "is it
// running, which version, and has it been restarted since?" without asking
// Iddo. He asked for this directly after restarting for a fix and there being
// no way to confirm which build was actually live - the source version in
// package.json says what is on disk, not what is running.
function writeRuntimeStamp() {
  try {
    const stamp = {
      version: app.getVersion(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      testMode: testMode.TEST_MODE,
      electron: process.versions.electron,
    };
    fs.writeFileSync(path.join(app.getPath("userData"), "runtime.json"), JSON.stringify(stamp, null, 2), "utf-8");
  } catch (e) {
    /* never a reason to fail startup */
  }
}

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
// Agent Desktop keeps its OWN copy of the Claude Code CLI under userData,
// installed/updated with `npm install -g --prefix <dir>` into a plain
// directory it fully controls. Why (found live 2026-09-07): on a machine
// where `claude` is Claude Desktop's *bundled* copy (%APPDATA%\npm\claude.cmd
// is a symlink into the MSIX package store), `npm install -g` into the
// default prefix cannot move that version - the write lands in a virtualized
// package overlay the real binary never reads (npm reports success, the
// version never changes). Installing into a normal private dir works and
// gets the true `@latest`. Claude Desktop's bundled copy is left untouched
// and stays the fallback until/unless the private one exists.
function privateCliDir() {
  return path.join(app.getPath("userData"), "cli");
}
function privateCliCmd() {
  return path.join(privateCliDir(), "claude.cmd");
}
function privateCliPackageJson() {
  return path.join(privateCliDir(), "node_modules", "@anthropic-ai", "claude-code", "package.json");
}
// Written only after a fresh install has verified (`claude --version` ran
// clean), so a half-finished / interrupted install is never selected.
function privateCliMarker() {
  return path.join(privateCliDir(), "agent-desktop-cli.json");
}
function privateCliReady() {
  // Deliberately reads actual bytes rather than fs.existsSync: existsSync
  // has proven unreliable in this app's launch context for some paths (see
  // resolveClaudeExecutable's history) - and a freshly npm-installed `cli`
  // dir being scanned by Defender right at boot is exactly the kind of
  // transient that would make existsSync lie. A successful JSON.parse of
  // both the marker and the package's own package.json is the honest
  // "it's really there and complete" check. BOM-tolerant: a marker written
  // by PowerShell Set-Content -Encoding utf8 carries a UTF-8 BOM that plain
  // JSON.parse chokes on.
  try {
    const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, ""));
    const marker = readJson(privateCliMarker());
    const pkg = readJson(privateCliPackageJson());
    return !!(marker && marker.version && pkg && pkg.version);
  } catch (e) {
    return false;
  }
}

function resolveClaudeExecutable() {
  // Agent Desktop's own managed copy wins when present - it's the one this
  // app can actually keep updated (see the block comment above).
  if (privateCliReady()) return privateCliCmd();
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

// Added 2026-08-23, asked for directly: Iddo wants every agent this app
// dispatches to be reachable from his phone (or any other device) without
// a manual per-agent step. A background agent, on its own, never registers
// with Anthropic's servers - it's a purely local process, invisible to
// claude.ai/code, the Claude mobile app, or this Desktop app's own Code
// tab, until something explicitly runs `/remote-control` inside it (real,
// live-confirmed: Iddo's own screenshot of Claude Desktop's Code tab showed
// only the Security project, nothing for Testing agent or LensVid, despite
// both running the whole time). `remoteControlAtStartup: true` in the
// user-level settings.json is the documented, official way to make every
// future interactive Claude Code session auto-connect at launch
// (https://code.claude.com/docs/en/remote-control#enable-remote-control-for-all-sessions)
// - confirmed it has to be user-level specifically, not project/local
// settings, which the docs say Claude Code only ever honors a `false` from,
// never a `true`. Same idempotent, non-destructive pattern as
// ensureRateLimitStatusLine() above: only ever sets this if Iddo hasn't
// already made an explicit choice either way, never overwrites a real
// false he set on purpose.
//
// Scope worth being clear about: this is a genuinely global, user-level
// setting - it affects every future interactive `claude` session on this
// machine, including ones Iddo starts in a plain terminal himself, not
// just Agent Desktop's own dispatched agents. That's exactly what he asked
// for ("every agent... reachable from anywhere"), not a side effect to
// hide. Confirmed with him directly before making this change (auto mode's
// own classifier flagged the first attempt as worth a real human okay on,
// not just proceeding silently).
//
// Only covers sessions started AFTER this setting exists - an already-
// running background agent (like Testing agent/LensVid were at the moment
// this was added) needs one manual `/remote-control` to register for the
// first time, or a restart, since the setting is only read at a session's
// own startup.
function ensureRemoteControlEnabled() {
  const settingsPath = path.join(app.getPath("home"), ".claude", "settings.json");
  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
    if ("remoteControlAtStartup" in settings) return; // Iddo (or something else) already made an explicit choice - leave it alone
    settings.remoteControlAtStartup = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    // Non-critical - agents just stay local-only (the pre-existing
    // behavior) if this never gets installed.
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

// Small persistent "already shown / dismissed" flags for one-time UI notes. Kept in a plain JSON file
// in userData (survives app updates, and unlike the renderer's localStorage it cannot be silently
// lost - the groups note kept coming back after being dismissed, 2026-09-19/20).
const UI_FLAGS_PATH = path.join(app.getPath("userData"), "ui-flags.json");
function readUiFlags() {
  try {
    const v = JSON.parse(fs.readFileSync(UI_FLAGS_PATH, "utf-8"));
    return v && typeof v === "object" ? v : {};
  } catch (e) {
    return {};
  }
}
ipcMain.handle("ui-flags-get", () => readUiFlags());
ipcMain.handle("ui-flag-set", (event, { key, value }) => {
  try {
    if (typeof key !== "string" || !key) return false;
    const flags = readUiFlags();
    flags[key] = value;
    fs.writeFileSync(UI_FLAGS_PATH, JSON.stringify(flags, null, 2));
    return true;
  } catch (e) {
    return false;
  }
});

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

// Install / update Agent Desktop's OWN private copy of the Claude Code CLI
// (see the privateCli* block near resolveClaudeExecutable for why a private
// copy is the only thing this app can reliably keep current on a
// bundled-CLI machine).
//
// History that led here (2026-09-07): a first attempt updated the shared
// npm-global in place, risking an EPERM folder-swap race against live
// agents. A second attempt quit the whole app and ran a detached updater
// that (a) force-killed every `claude.exe` on the machine by name -
// including the user's own interactive session - and (b) still couldn't
// move the bundled copy's version. Both abandoned. This approach avoids
// all of it: install into a fresh private dir, and only ever stop THIS
// app's own background agents (by the cwds it dispatched), never anything
// matched by process name, and never the app itself.
ipcMain.handle("update-claude-cli", async () => {
  if (process.platform !== "win32") {
    throw new Error("Managed CLI update is implemented for Windows only.");
  }
  const dir = privateCliDir();
  fs.mkdirSync(dir, { recursive: true });

  // 1. Stop only OUR background agents + live attach ptys, so nothing from
  //    the private dir holds a file handle during npm's swap. They
  //    re-dispatch (on the new CLI) the next time the renderer reattaches.
  try {
    for (const agent of listAgents()) {
      await stopBackgroundAgentForCwd(sessionCwdFor(agent.path));
    }
  } catch (e) {
    /* best-effort */
  }
  for (const [, session] of ptySessions) {
    try {
      if (session.archiveTimer) clearInterval(session.archiveTimer);
      if (session.proc) session.proc.kill();
    } catch (e) {}
  }
  ptySessions.clear();

  // 2. Install @latest into the private prefix (works where a default-prefix
  //    -g install silently no-ops against the bundled copy).
  const npmPath = resolveNpmExecutable();
  const env = { ...process.env, DISABLE_AUTOUPDATER: "1" };
  await runClaudeCommand(
    npmPath,
    ["install", "-g", "--prefix", dir, "@anthropic-ai/claude-code@latest", "--no-audit", "--no-fund"],
    { env, cwd: dir },
    3,
    800
  );

  // 3. Verify against the freshly-installed binary itself.
  let version = null;
  try {
    const out = await runClaudeCommand(privateCliCmd(), ["--version"], { env }, 3, 500);
    const m = String(out).trim().match(/(\d+\.\d+\.\d+)/);
    if (m) version = m[1];
  } catch (e) {
    /* falls through to the throw below */
  }
  if (!version || !fs.existsSync(privateCliPackageJson())) {
    throw new Error(
      "The CLI install ran but couldn't be verified. Agent Desktop is still using its previous Claude Code - " +
        "try again, or run 'npm install -g @anthropic-ai/claude-code@latest' in a terminal."
    );
  }

  // 4. Only now mark it ready, so resolveClaudeExecutable() switches over.
  fs.writeFileSync(
    privateCliMarker(),
    JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );

  // 5. Restart the app so every agent comes back fresh on the new CLI and
  //    the version line updates. The update itself is already fully done
  //    and verified on disk at this point - the relaunch does no real work,
  //    so it can't half-fail the way the abandoned "quit then run an
  //    external updater" flow could.
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    buttons: ["Restart now"],
    defaultId: 0,
    title: "Claude Code updated",
    message: "Updated to Claude Code " + version + ".",
    detail: "Agent Desktop will restart now so your agents reconnect on the new version.",
  });
  relaunchApp();
  return { version, restarting: true };
});

// Restart Agent Desktop. Two mechanisms fired together, which is safe
// because requestSingleInstanceLock() (see further down) means a second
// launch just focuses the first window rather than opening another:
//  - app.relaunch(): Electron's own detached wait-for-exit-then-start
//    helper. The normal path.
//  - a tiny detached .vbs that sleeps a few seconds then runs Launch.vbs
//    (the exact chain Start_Agents_Dashboard.bat uses). Backup, in case
//    app.relaunch() misbehaves for this non-packaged `electron .` setup.
// If somehow neither takes, the app just closes and the user reopens it -
// and the update is already applied, so nothing is lost.
function relaunchApp() {
  try {
    app.relaunch();
  } catch (e) {
    /* fall through to the vbs backup */
  }
  try {
    if (process.platform === "win32") {
      const launchVbs = path.join(__dirname, "..", "Launch.vbs");
      const relaunchVbs = path.join(app.getPath("userData"), "relaunch.vbs");
      fs.writeFileSync(
        relaunchVbs,
        'WScript.Sleep 4000\r\n' +
          'CreateObject("WScript.Shell").Run "wscript.exe //B ""' + launchVbs + '""", 0, False\r\n',
        "utf-8"
      );
      spawn("wscript.exe", ["//B", relaunchVbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
  } catch (e) {
    /* best-effort backup only */
  }
  setTimeout(() => app.quit(), 500);
}

// ------------------------------------------------ Update & restart (v1.58.0) --
// See src/app-update.js for what counts as "newer" and what is refused. Here:
// the IPC, and the restart. Agents are `claude --bg` processes that survive
// the app quitting and are reattached on start, so a restart costs them
// nothing - the renderer's overlay still waits for them to be idle first, so
// no reply is mid-stream on screen when the window goes away.
appUpdate.init({ app, runClaudeCommand, testMode, isVersionNewer });

ipcMain.handle("app-update-status", (event, opts) => appUpdate.getStatus(opts || {}));

ipcMain.handle("app-update-apply", async () => {
  const r = await appUpdate.apply();
  if (!r.ok) return r;
  if (r.testMode) return { ...r, restarting: false }; // never relaunch the live app from the sandbox
  // app.quit() does not fire window-all-closed, so flush the chat archive here.
  for (const [agentPath, session] of ptySessions) {
    try {
      syncArchive(agentPath, session.sessionCwd);
    } catch (e) {}
  }
  logStuckWatchdog(`update & restart: v${app.getVersion()} -> v${r.version || "?"}`);
  setTimeout(relaunchApp, 300); // let this reply reach the renderer first
  return { ...r, restarting: true };
});

ipcMain.handle("app-update-open-release", (event, url) => {
  if (typeof url === "string" && url.startsWith(`https://github.com/${appUpdate.RELEASES_REPO}/`)) shell.openExternal(url);
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

// ------------------------------------------------------- startup countdown --
// v1.53.0. Iddo: "Can you put some big numbers on the screen (counting down)
// until agent desktop fully loads so I will know not to interact with it until
// it's ready?" For the first stretch after a launch (or a relaunch.vbs restart
// after a CLI update) the window is up but the first ensureAllAgentsBackgrounded
// sweep is still running `claude agents --json` / `claude --bg` per agent, and
// clicks into the window are unreliable - it can even show "(Not Responding)".
//
// "Ready" means BOTH: the first sweep has processed every unpaused agent
// (success or failure - a failed agent still counts as processed, the sweep
// never waits on it again) AND the renderer has finished loading. The renderer
// (startup-overlay.js) draws a full-window countdown until then.
//
// The countdown's starting figure is a measurement, not a guess: every real
// startup's app-start -> ready duration is appended to startup-timing.json and
// the next launch counts down from the average of the last 3 (60 s if none).
// Test-mode launches that skip the sweep are ready at once and are NOT recorded,
// so a sandbox run cannot drag the live estimate down (the sandbox has its own
// userData anyway, but the rule holds either way).
const STARTUP_TIMING_PATH = path.join(app.getPath("userData"), "startup-timing.json");
const STARTUP_DEFAULT_ESTIMATE_MS = 60 * 1000;
const STARTUP_TIMING_KEEP = 20; // history kept on disk; only the last 3 are averaged
const STARTUP_TIMING_AVERAGE_OF = 3;
// Module load is as close to "process start" as this file can see; the gap
// before it is Electron's own boot, which the user sees as no window at all.
const APP_START_MS = Date.now();

function readStartupTimings() {
  try {
    const doc = JSON.parse(fs.readFileSync(STARTUP_TIMING_PATH, "utf-8"));
    return Array.isArray(doc.runs) ? doc.runs.filter((r) => r && Number.isFinite(r.durationMs) && r.durationMs > 0) : [];
  } catch (e) {
    return []; // first run, or an unreadable file - fall back to the default
  }
}

function estimateStartupMs() {
  const recent = readStartupTimings().slice(-STARTUP_TIMING_AVERAGE_OF);
  if (!recent.length) return STARTUP_DEFAULT_ESTIMATE_MS;
  return Math.round(recent.reduce((sum, r) => sum + r.durationMs, 0) / recent.length);
}

const startupState = {
  startedAt: APP_START_MS,
  estimateMs: estimateStartupMs(),
  total: 0, // unpaused agents in the first sweep; 0 until the sweep has listed them
  done: 0,
  agentName: null, // the agent most recently processed
  sweepDone: false,
  rendererLoaded: false,
  ready: false,
  readyAt: null,
  dismissed: false, // "Use it anyway" - remembered here so a renderer reload doesn't re-show it
};

function sendStartup(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, payload);
    } catch (e) {}
  }
}

function startupSnapshot() {
  const { startedAt, estimateMs, total, done, agentName, ready, readyAt, dismissed } = startupState;
  return { startedAt, estimateMs, total, done, agentName, ready, readyAt, dismissed, now: Date.now() };
}

async function recordStartupTiming(durationMs) {
  try {
    const runs = readStartupTimings();
    runs.push({ at: new Date().toISOString(), durationMs, agents: startupState.total, version: app.getVersion() });
    const doc = JSON.stringify({ runs: runs.slice(-STARTUP_TIMING_KEEP) }, null, 2);
    await withFsRetryAsync(() => fs.promises.writeFile(STARTUP_TIMING_PATH, doc, "utf-8"));
  } catch (e) {
    logStuckWatchdog(`startup timing not saved: ${e.message}`);
  }
}

function maybeMarkStartupReady() {
  if (startupState.ready || !startupState.sweepDone || !startupState.rendererLoaded) return;
  startupState.ready = true;
  startupState.readyAt = Date.now();
  sendStartup("startup-ready", startupSnapshot());
}

// Called once, when the first sweep returns (however it returns). `measured`
// is false when there was nothing real to measure - the sweep was skipped in
// test mode, or listAgents() failed - so those launches don't pollute the
// estimate.
function markStartupSweepDone(measured) {
  if (startupState.sweepDone) return;
  startupState.sweepDone = true;
  const durationMs = Date.now() - APP_START_MS;
  logStuckWatchdog(`startup: first sweep done after ${Math.round(durationMs / 1000)}s (${startupState.done}/${startupState.total} agents${measured ? "" : ", not recorded"})`);
  if (measured) recordStartupTiming(durationMs);
  maybeMarkStartupReady();
}

// Progress hook handed to the FIRST ensureAllAgentsBackgrounded() call only;
// the 15-minute sweeps after it run without one.
const startupProgress = {
  begin(total) {
    startupState.total = total;
    sendStartup("startup-progress", startupSnapshot());
  },
  agentDone(agentName) {
    startupState.done += 1;
    startupState.agentName = agentName;
    sendStartup("startup-progress", startupSnapshot());
  },
};

ipcMain.handle("get-startup-state", () => startupSnapshot());
ipcMain.on("startup-dismiss", () => {
  startupState.dismissed = true;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: testMode.TEST_MODE ? SANDBOX_WINDOW_TITLE : "Agent Desktop",
    backgroundColor: "#0f1115",
    // Amber rather than the usual blue. Iddo's ask after seeing two identical
    // icons sitting next to each other in the taskbar: the title alone does
    // not help there, because both truncate to a few characters.
    icon: path.join(__dirname, "..", "build", testMode.TEST_MODE ? "icon-sandbox.ico" : "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Chromium's built-in PDF viewer, so the Library can show documents in
      // the app itself (v1.39.0 - Iddo: documents as PDF, viewable in the
      // main screen with a back button).
      plugins: true,
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
  // index.html carries its own <title>, and Electron lets a page's title win
  // over the BrowserWindow `title` option - which is why the first sandbox
  // launch still read "Agent Desktop" despite setting it above. Refusing the
  // page's update and setting the title explicitly is what actually holds it.
  if (testMode.TEST_MODE) {
    mainWindow.on("page-title-updated", (e) => e.preventDefault());
    mainWindow.setTitle(SANDBOX_WINDOW_TITLE);
  }

  // Sandbox-only UI experiments, injected rather than linked from index.html
  // so the live app cannot pick them up even accidentally. This is what lets a
  // proposed redesign be looked at in the sandbox first and then kept or
  // thrown away - see styles-experimental.css for the current one.
  // v1.37.0: the header/Tasks-panel experiment graduated to index.html, so
  // there may be no experiment at all - absent files are the normal case now,
  // not an error. Drop a new styles-experimental.css / experimental.js into
  // renderer\ to start the next one.
  const xpCss = path.join(__dirname, "renderer", "styles-experimental.css");
  if (testMode.TEST_MODE && fs.existsSync(xpCss)) {
    mainWindow.webContents.on("did-finish-load", () => {
      try {
        const css = fs.readFileSync(xpCss, "utf-8");
        // A real <style> element appended to <head>, NOT webContents.insertCSS.
        // insertCSS injects at the user-stylesheet level, which loses to the
        // app's own author styles on equal specificity - confirmed live: the
        // button overrides applied (no competing rule) while every badge
        // override silently lost to styles.css. Appending an author
        // stylesheet last makes normal cascade order do the work, with no
        // !important anywhere.
        mainWindow.webContents.executeJavaScript(
          `(() => { const s = document.createElement("style");
                    s.id = "experimental-css";
                    s.textContent = ${JSON.stringify(css)};
                    document.head.appendChild(s);
                    return true; })()`
        );
        // The JS half of a proposal (restructured header, task panel). Runs
        // after the CSS so the styles it relies on already exist. It never
        // reimplements behaviour - it hides the original controls and clicks
        // them through - so a failure here is cosmetic, not functional.
        const xpJs = path.join(__dirname, "renderer", "experimental.js");
        if (fs.existsSync(xpJs)) {
          mainWindow.webContents.executeJavaScript(fs.readFileSync(xpJs, "utf-8")).catch((e) =>
            logStuckWatchdog(`experimental JS failed: ${e.message}`)
          );
        }
      } catch (e) {
        logStuckWatchdog(`experimental CSS not applied: ${e.message}`);
      }
    });
  }

  // Second half of the startup "ready" condition (see startupState). Fires on
  // every load, including a renderer reload - harmless after the first.
  mainWindow.webContents.on("did-finish-load", () => {
    startupState.rendererLoaded = true;
    maybeMarkStartupReady();
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Electron gives a BrowserWindow no OS-native right-click menu and blocks
  // target="_blank" links by default - neither was ever wired up here,
  // which is exactly why copying (or even opening) a link, or copying
  // plain text without a per-message button, has never worked in this app.
  // Iddo hit this directly asking to copy something from a chat.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("context-menu", (event, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
        { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
        { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { label: "Select All", role: "selectAll" }
      );
    } else if (params.selectionText) {
      // Not webContents.copy()'s built-in role here - that copies whatever
      // the OS selection currently is, which can change/clear between the
      // right-click and the menu-item click on a slower machine. Capturing
      // params.selectionText now and writing it explicitly is safer.
      template.push({
        label: "Copy",
        click: () => clipboard.writeText(params.selectionText),
      });
    }
    if (params.linkURL) {
      if (template.length) template.push({ type: "separator" });
      template.push(
        { label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) },
        { label: "Open Link in Browser", click: () => shell.openExternal(params.linkURL) }
      );
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
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
    ensureRemoteControlEnabled();
    reapOrphanedBackgroundAgentProcesses();
    setInterval(reapOrphanedBackgroundAgentProcesses, REAPER_INTERVAL_MS);
    setInterval(() => {
      checkForStuckTurns().catch((e) => logStuckWatchdog(`checkForStuckTurns error: ${e.message}`));
    }, STUCK_CHECK_INTERVAL_MS);
    setInterval(() => {
      checkForHaltedTurns().catch((e) => logStuckWatchdog(`checkForHaltedTurns error: ${e.message}`));
    }, STUCK_CHECK_INTERVAL_MS);
    setInterval(() => {
      try {
        checkForAuthFailure();
      } catch (e) {
        logStuckWatchdog(`checkForAuthFailure error: ${e.message}`);
      }
    }, STUCK_CHECK_INTERVAL_MS);
    // Give the app's own startup (window, statusline, reaper) a moment to
    // settle before launching a CLI process per configured agent. Respects
    // the `paused` flag (agents.js setAgentPaused) - see that function's
    // and this sweep's own comments for why that flag exists.
    // The first sweep also drives the startup countdown overlay: it reports
    // each agent through startupProgress, and its end (normal, skipped or
    // thrown) marks the sweep half of "ready". A throw is logged and still
    // counts as done - the overlay must never wait on a sweep that has ended.
    // A sandbox whose sweep will be skipped anyway is ready at once rather
    // than after the 10 s settle delay below.
    if (!testMode.liveAgentsPermitted()) markStartupSweepDone(false);
    setTimeout(() => {
      ensureAllAgentsBackgrounded(startupProgress)
        .then((result) => markStartupSweepDone(!!(result && result.measured)))
        .catch((e) => {
          logStuckWatchdog(`ensureAllAgentsBackgrounded startup error: ${e.message}`);
          markStartupSweepDone(false);
        });
    }, 10000);
    setInterval(() => {
      ensureAllAgentsBackgrounded().catch((e) => logStuckWatchdog(`ensureAllAgentsBackgrounded interval error: ${e.message}`));
    }, ENSURE_AGENTS_ALIVE_INTERVAL_MS);
    setInterval(repinAllAgentNames, REPIN_AGENT_NAMES_INTERVAL_MS);
    writeRuntimeStamp();
    logStuckWatchdog(`started v${app.getVersion()} pid=${process.pid} (${testMode.describe()})`);
    if (testMode.TEST_MODE) {
      enforceTestTokenBudget();
      setInterval(enforceTestTokenBudget, TEST_BUDGET_CHECK_INTERVAL_MS);
    }
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

// Sidebar groups ("folders"). Visual-only - see src/groups.js for the full
// contract. The renderer sends the whole document back on every change
// (single user, single window via requestSingleInstanceLock, small file), and
// writeGroups() normalizes + persists it and returns the cleaned copy.
ipcMain.handle("list-groups", () => readGroups());
ipcMain.handle("save-groups", (event, { doc }) => writeGroups(doc));

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
  // v1.54.0: Claude Code (2.1.281+) will not run `claude --bg` in a folder
  // whose workspace-trust prompt was never accepted - under this app's pty it
  // just waits on the prompt, so the new agent would never start. Creating
  // the agent here IS Iddo's consent for this one folder (he just named it
  // and clicked Create), so its .claude-session is trusted now. Existing
  // agents are never trusted silently - they go through the untrusted banner
  // and its button instead. Skipped in a fixtures-only sandbox, which must not
  // touch the real ~/.claude.json. A failure is logged, not fatal: the agent
  // then shows up in the untrusted banner on its first dispatch.
  if (testMode.liveAgentsPermitted()) {
    try {
      const r = workspaceTrust.markFoldersTrusted([sessionCwdFor(agentDir)]);
      logStuckWatchdog(`create-agent: trusted new agent folder ${agentDir} (verified=${r.verified}, backup=${r.backupPath || "none"})`);
    } catch (e) {
      logStuckWatchdog(`create-agent: could not trust new agent folder ${agentDir}: ${e.message}`);
    }
  }
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

// --- Agent instructions (the agent folder's own CLAUDE.md) ---------------
// This is the file Claude Code actually loads as the agent's standing
// instructions every session - distinct from the short `role` blurb in
// agent_config.json. Editing it in-app means a user (not just a Claude
// session willing to write files) can set an agent up.
function agentClaudeMdPath(agentPath) {
  const resolved = path.resolve(agentPath);
  // Only ever touch a CLAUDE.md that sits directly inside a real agent
  // folder one level under the agents root - refuse anything else outright
  // rather than trust the caller's path.
  if (path.dirname(resolved) !== path.resolve(AGENTS_ROOT)) {
    throw new Error("Refusing to touch a path outside the agents root");
  }
  return path.join(resolved, "CLAUDE.md");
}

ipcMain.handle("read-instructions", (event, { agentPath }) => {
  const file = agentClaudeMdPath(agentPath);
  if (!fs.existsSync(file)) return { exists: false, content: "", mtimeMs: null };
  const content = fs.readFileSync(file, "utf-8");
  const mtimeMs = fs.statSync(file).mtimeMs;
  return { exists: true, content, mtimeMs };
});

ipcMain.handle("write-instructions", async (event, { agentPath, content, baseMtimeMs, force }) => {
  const file = agentClaudeMdPath(agentPath);
  const exists = fs.existsSync(file);
  if (!force) {
    // Conflict check: the file changed on disk since the editor loaded it
    // (Claude edited it, an external editor, a Dropbox-synced change from
    // another machine). Hand the current content back so the renderer can
    // offer to reload rather than silently clobbering.
    const currentMtime = exists ? fs.statSync(file).mtimeMs : null;
    const changed = exists
      ? baseMtimeMs == null || Math.abs(currentMtime - baseMtimeMs) > 1
      : baseMtimeMs != null;
    if (changed) {
      return {
        conflict: true,
        content: exists ? fs.readFileSync(file, "utf-8") : "",
        mtimeMs: currentMtime,
      };
    }
  }
  await withFsRetryAsync(() => fs.writeFileSync(file, content, "utf-8"));
  return { ok: true, mtimeMs: fs.statSync(file).mtimeMs };
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
  if (untrustedAgents.delete(path.resolve(agentPath))) sendUntrustedAgents();
  return { ok: true };
});

// 2026-09-20: the actual "stop an agent" Iddo asked for, distinct from
// delete-agent (which also removes the folder) - a real reason to want this
// short of deleting anything: a runaway/looping agent burning usage, a
// project on hold, freeing up the machine for something heavy. Persists via
// agents.js's setAgentPaused() so ensureAllAgentsBackgrounded()'s periodic
// sweep (elsewhere in this file) skips it and won't resurrect it - without
// this flag, that sweep would otherwise bring back ANY stopped agent within
// its own re-check interval, since delete was previously the only way to
// stop a background process at all. Pausing tears down the live pty (same
// pattern as delete-agent, just without removing the folder) and stops the
// underlying `claude --bg` process; resuming immediately re-dispatches it in
// the background (no pty attach - that only happens if/when the chat tab is
// actually opened) so it's reachable again right away rather than waiting
// for the next sweep.
ipcMain.handle("set-agent-paused", async (event, { agentPath, paused }) => {
  const newState = setAgentPaused(agentPath, paused);
  if (newState) {
    const session = ptySessions.get(agentPath);
    if (session) {
      try {
        clearInterval(session.archiveTimer);
      } catch (e) {}
      ptySessions.delete(agentPath);
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
  } else {
    try {
      const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
      const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", ...CLAUDE_AUTOUPDATER_DISABLE_ENV };
      await findOrDispatchBackgroundAgent(shell, spawnEnv, sessionCwdFor(agentPath));
    } catch (e) {
      logStuckWatchdog(`set-agent-paused resume dispatch failed for ${agentPath}: ${e.message}`);
    }
  }
  return { ok: true, paused: newState };
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

// 2026-09-20: for a message long enough to risk the terminal-input
// corruption documented at writeToPtyChunked() below (confirmed live,
// repeatedly, well past what bracketed-paste alone reliably fixed) - write
// it to a plain text file and tell the agent to read it with its own Read
// tool instead of typing/pasting it at all. This is the same reliable
// mechanism a pasted image already uses (a file reference, not raw
// keystrokes) and sidesteps the terminal-input pipeline entirely rather
// than trying to make a large paste survive it.
const LONG_MESSAGE_DIR = path.join(app.getPath("temp"), "agent-desktop-long-messages");
// Reads back a long message the renderer wrote, so the chat bubble can show
// what Iddo actually typed instead of the file path the CLI was handed.
// 2026-09-22, his words: "it needs to actually show the message even if it
// sends it in a file." The file reference is a transport detail; the message
// is the thing he wrote and the thing he needs to see when scrolling back.
//
// Confined to LONG_MESSAGE_DIR on purpose - the renderer supplies this path
// from transcript text, so it must not be able to ask for an arbitrary file.
ipcMain.handle("read-long-message", (event, { filePath }) => {
  try {
    const dir = path.resolve(LONG_MESSAGE_DIR);
    const resolved = path.resolve(String(filePath || ""));
    if (!resolved.startsWith(dir + path.sep)) return null;
    return fs.readFileSync(resolved, "utf-8");
  } catch (e) {
    return null; // a missing file just means the bubble keeps its current text
  }
});

ipcMain.handle("save-long-message", (event, { text }) => {
  fs.mkdirSync(LONG_MESSAGE_DIR, { recursive: true });
  const filePath = path.join(LONG_MESSAGE_DIR, `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(filePath, text, "utf-8");
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

// Auto-registers every freshly-dispatched agent with Claude Code's Remote
// Control (claude.ai/code, the mobile app) - requested directly by Iddo
// (2026-09-04) after tracing why his agents never showed up remotely.
// Root cause: this app always runs agents as `claude --bg` (see
// dispatchBackgroundAgent above), and the `remoteControlAtStartup: true`
// user setting (ensureRemoteControlEnabled() in this file) only auto-
// connects INTERACTIVE sessions - `claude --help` is explicit that
// `--remote-control` itself "start[s] an interactive session with Remote
// Control enabled". A background agent never gets that automatic
// connection no matter what the setting says. The one-time manual
// `/remote-control` run per agent on 2026-08-23 proved a bg session CAN
// still register if you run the command inside it - it just isn't
// automatic, and that manual registration is tied to the live process, so
// it was lost the moment each agent's bg session ended. This closes the
// gap by running the same command, and answering its own confirm prompt,
// right after every FRESH dispatch (see findOrDispatchBackgroundAgent's
// freshlyDispatched flag) - not on a reattach to a bg agent that's still
// alive, since that one already went through this exact registration when
// IT was first dispatched.
const REMOTE_CONTROL_REGISTER_WAIT_MS = 2500;
const REMOTE_CONTROL_CONFIRM_RE = /Enable Remote Control/i;
// Live-verified (2026-09-04, via `claude logs` on a real freshly-dispatched
// bg agent): selecting "1. Enable Remote Control" doesn't return straight
// to a normal session - it shows a follow-up summary panel first ("Remote
// Control" heading, the session's claude.ai/code URL, Disconnect/QR-code
// options, a highlighted "❯ Continue") that itself needs one more Enter to
// dismiss. Without answering this too, the session sits there permanently
// (`claude agents --json` showed status "waiting"/waitingFor:"dialog open"
// forever) - confirmed live that a single extra Enter is exactly what
// clears it, same as every other menu here defaults to its highlighted
// option.
const REMOTE_CONTROL_SUCCESS_RE = /This session is available in the Claude mobile app/i;

// Deliberately best-effort and silent: this is plumbing, not something the
// user needs to see happen, and an agent that fails to register should
// just stay local-only - exactly the pre-existing behavior - rather than
// this ever blocking or breaking a real chat session opening. Uses its own
// private onData listener rather than the permanent one (attached later in
// startTerminalSession) specifically so its own "/remote-control" echo and
// the confirm-menu redraw never reach the renderer/Chat View - purely
// internal, same spirit as the login/resume-dialog peeks right above it.
async function registerRemoteControl(proc) {
  try {
    let buffer = "";
    const disposable = proc.onData((d) => {
      buffer += d;
    });
    // Text and Enter as two separately-timed writes, not one combined write -
    // the same pattern submitToAgent() in renderer.js uses for every real
    // chat message (text, then a staggered "\r"), and for the same reason:
    // sending them together can land before the CLI is actually reading
    // input yet.
    proc.write("/remote-control");
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.write("\r");
    await new Promise((resolve) => setTimeout(resolve, REMOTE_CONTROL_REGISTER_WAIT_MS));
    if (REMOTE_CONTROL_CONFIRM_RE.test(stripTerminalCodes(buffer))) {
      // "1. Enable Remote Control" / "2. Never mind" - same write-key,
      // wait, write-Enter sequence already proven to work against the
      // RESUME_DIALOG_RE menu above, just selecting option 1 instead of 3.
      proc.write("1");
      await new Promise((resolve) => setTimeout(resolve, 300));
      proc.write("\r");
      await new Promise((resolve) => setTimeout(resolve, REMOTE_CONTROL_REGISTER_WAIT_MS));
    }
    // See REMOTE_CONTROL_SUCCESS_RE above - the post-enable summary panel
    // needs its own dismiss. `buffer` has kept accumulating everything
    // since the very first write, so it already contains this panel's text
    // if it appeared during either wait above.
    if (REMOTE_CONTROL_SUCCESS_RE.test(stripTerminalCodes(buffer))) {
      proc.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    disposable.dispose();
  } catch (e) {
    /* best-effort - see comment above */
  }
}

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
  // options.timeoutMs (opt-in, 2026-09-24): without it a CLI call that never
  // exits blocks its caller forever. Seen live right after a Claude Code
  // update: the sweep's `claude --bg` dispatches were spawned before the
  // CLI's daemon came back, never exited, and ensureAllAgentsBackgrounded()
  // sat on them - so no agent was relaunched and Software Engineering never
  // answered. Opt-in because npm installs legitimately run for minutes.
  //
  // options.abortPattern (opt-in, v1.54.0): a RegExp checked against the
  // output as it streams. On a match the pty is killed at once and the call
  // rejects with err.aborted = true and err.abortOutput, instead of waiting
  // for the process to exit or for timeoutMs. Built for Claude Code's
  // workspace-trust prompt, which under a pty waits for a keypress forever
  // (see workspaceTrust.js) - but generic, for any interactive prompt a
  // one-shot call must never sit on. The pattern is tested against the text
  // with terminal codes and ALL whitespace removed (ConPTY can draw a space
  // as a cursor move), so write it with \s* between words.
  return new Promise((resolve, reject) => {
    let output = "";
    let timer = null;
    let settled = false;
    const abortMatches = () => {
      if (!options.abortPattern) return false;
      const tail = output.length > 8000 ? output.slice(-8000) : output;
      return options.abortPattern.test(stripTerminalCodes(tail).replace(/\s+/g, ""));
    };
    const abortError = () => {
      const err = new Error(`claude ${args.join(" ")} aborted: output matched ${options.abortPattern}`);
      err.aborted = true;
      err.abortOutput = stripTerminalCodes(output);
      return err;
    };
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          proc.kill();
        } catch (e) {
          /* already gone */
        }
        const err = new Error(`claude ${args.join(" ")} timed out after ${options.timeoutMs}ms`);
        err.timedOut = true;
        reject(err);
      }, options.timeoutMs);
    }
    proc.onData((data) => {
      output += data;
      if (settled || !abortMatches()) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        proc.kill();
      } catch (e) {
        /* already gone */
      }
      reject(abortError());
    });
    proc.onExit(() => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      // The plain-shell form of a prompt (e.g. "Workspace not trusted ...")
      // prints and exits rather than waiting - still an abort, not output.
      if (abortMatches()) {
        reject(abortError());
        return;
      }
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

const CLAUDE_CLI_TIMEOUT_MS = 90 * 1000; // see runClaudeCommandOnce's timeoutMs
async function listBackgroundAgents(shell, spawnEnv) {
  try {
    const output = await runClaudeCommand(shell, ["agents", "--json", "--all"], { env: spawnEnv, timeoutMs: CLAUDE_CLI_TIMEOUT_MS });
    return JSON.parse(output);
  } catch (e) {
    // A timeout means "unknown", not "none alive": returning [] here would
    // make callers dispatch a duplicate of an agent that may be running.
    if (e.timedOut) throw e;
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
//
// opts (all optional, used by the Chats panel's switch / new-conversation
// actions - see the "conversation-*" IPC handlers below):
//   resumeSessionId - resume this exact past conversation (`--bg --resume <id>`)
//                     instead of the most-recent one `--continue` would pick.
//   forceFresh      - start a brand-new conversation (`--bg`, no --continue)
//                     even though prior sessions exist for this cwd.
// v1.54.4 (2026-09-25): duplicate-dispatch guard. Seen live at 03:06: a
// planned context reset dispatched a fresh `--bg` for System Optimization,
// and 3 s later the keep-alive sweep - whose `claude agents` listing did not
// show the new process yet - dispatched a SECOND one for the same folder. Two
// live copies of one agent left the app showing it "not running" and Iddo's
// messages undelivered. Every dispatch stamps its cwd here, and the sweep
// leaves alone any agent something else dispatched within the grace window.
const DISPATCH_GRACE_MS = 90 * 1000;
const lastDispatchAt = new Map(); // path.resolve(sessionCwd).toLowerCase() -> ms
function dispatchKey(sessionCwd) {
  return path.resolve(sessionCwd).toLowerCase();
}
function dispatchedRecently(sessionCwd) {
  const at = lastDispatchAt.get(dispatchKey(sessionCwd));
  return !!at && Date.now() - at < DISPATCH_GRACE_MS;
}

async function dispatchBackgroundAgent(shell, spawnEnv, sessionCwd, opts = {}) {
  lastDispatchAt.set(dispatchKey(sessionCwd), Date.now());
  let args;
  if (opts.resumeSessionId) {
    args = ["--bg", "--resume", opts.resumeSessionId];
  } else if (opts.forceFresh) {
    args = ["--bg"];
  } else {
    args = hasPriorSession(sessionCwd) ? ["--bg", "--continue"] : ["--bg"];
  }
  // Every `claude --bg` in this app goes through here (the sweep, opening a
  // chat, resume-after-pause, conversation switch, login recovery), so this is
  // the one place the workspace-trust prompt is caught - see workspaceTrust.js
  // and the untrusted-agents registry below. A match kills the pty at once
  // (no 90 s timeout) and rejects with err.untrusted = true.
  let output;
  try {
    output = await runClaudeCommand(shell, args, {
      cwd: sessionCwd,
      env: spawnEnv,
      timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
      abortPattern: workspaceTrust.TRUST_PROMPT_RE,
    });
  } catch (e) {
    if (e.aborted) {
      const err = new Error(
        `workspace not trusted: ${sessionCwd} - Claude Code wants its trust prompt accepted once before it will run this agent`
      );
      err.untrusted = true;
      err.sessionCwd = sessionCwd;
      noteAgentUntrusted(sessionCwd);
      throw err;
    }
    throw e;
  }
  // Real dispatch output (confirmed byte-for-byte via a live test dispatch):
  // "backgrounded \xC2\xB7 5467abbc (idle ...)" - a single U+00B7 MIDDLE DOT,
  // not a literal "." or multiple dots.
  const match = output.match(/backgrounded\s*·\s*([a-f0-9]+)/i);
  if (!match) {
    throw new Error("Could not parse background agent id from dispatch output: " + output);
  }
  // A clean dispatch proves the folder is trusted now (the button below, or
  // Iddo accepting the prompt in a terminal himself).
  clearAgentUntrusted(sessionCwd);
  // Stamp again on completion: the grace window runs from when the process
  // exists, not from when a possibly slow dispatch call began.
  lastDispatchAt.set(dispatchKey(sessionCwd), Date.now());
  return match[1];
}

// --- Untrusted agents (v1.54.0) ---------------------------------------------
// Agents whose `claude --bg` hit Claude Code's workspace-trust prompt. Keyed by
// agent folder path. The renderer shows a banner listing them with a "Trust and
// start them" button, and the same message in an untrusted agent's own chat
// pane instead of a silent hang. Nothing here grants trust by itself - only
// the "trust-agent-folders" IPC (Iddo's click) and create-agent do.
const untrustedAgents = new Map(); // agentPath -> { agentPath, displayName, sessionCwd, since }

function untrustedAgentsList() {
  return [...untrustedAgents.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function sendUntrustedAgents() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("untrusted-agents", untrustedAgentsList());
    } catch (e) {}
  }
}

function noteAgentUntrusted(sessionCwd) {
  const agentPath = path.dirname(path.resolve(sessionCwd));
  if (untrustedAgents.has(agentPath)) return;
  const displayName = agentDisplayName(agentPath);
  untrustedAgents.set(agentPath, { agentPath, displayName, sessionCwd: path.resolve(sessionCwd), since: new Date().toISOString() });
  logStuckWatchdog(`untrusted: ${displayName} (${sessionCwd}) - Claude Code's workspace-trust prompt blocks it; waiting for Iddo to trust it`);
  sendUntrustedAgents();
}

function clearAgentUntrusted(sessionCwd) {
  const agentPath = path.dirname(path.resolve(sessionCwd));
  if (!untrustedAgents.delete(agentPath)) return;
  logStuckWatchdog(`untrusted: cleared ${agentDisplayName(agentPath)} - it dispatched normally`);
  sendUntrustedAgents();
}

ipcMain.handle("get-untrusted-agents", () => untrustedAgentsList());

// Iddo's "Trust and start them" click. The ONLY path besides create-agent that
// writes workspace trust. Accepts agent folder paths, but only ones that are
// both real agents under the agents root AND currently in the untrusted list -
// so a renderer bug cannot be used to trust an arbitrary folder.
ipcMain.handle("trust-agent-folders", async (event, { agentPaths } = {}) => {
  const requested = Array.isArray(agentPaths) ? agentPaths.map((p) => path.resolve(String(p))) : [];
  const root = path.resolve(AGENTS_ROOT);
  const targets = requested.filter((p) => path.dirname(p) === root && untrustedAgents.has(p));
  if (!targets.length) return { ok: false, error: "None of those agents are waiting for trust.", results: [] };

  const names = targets.map((p) => untrustedAgents.get(p).displayName);
  let trustResult;
  try {
    trustResult = workspaceTrust.markFoldersTrusted(targets.map((p) => sessionCwdFor(p)));
  } catch (e) {
    logStuckWatchdog(`untrusted: trusting ${names.join(", ")} FAILED: ${e.message}`);
    return { ok: false, error: e.message, results: [] };
  }
  logStuckWatchdog(
    `untrusted: Iddo trusted ${names.join(", ")} - changed=${trustResult.changed.length} already=${trustResult.alreadyTrusted.length} ` +
      `verified=${trustResult.verified} backup=${trustResult.backupPath || "(no existing file)"}`
  );

  // Start them straight away with the same dispatch the sweep uses, one at a
  // time with the sweep's stagger. A successful dispatch clears the agent from
  // the untrusted list itself (clearAgentUntrusted, in dispatchBackgroundAgent).
  const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
  const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", ...CLAUDE_AUTOUPDATER_DISABLE_ENV };
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const agentPath = targets[i];
    const name = names[i];
    if (!testMode.liveAgentsPermitted()) {
      results.push({ agentPath, name, ok: false, error: "sandbox: live agents are off" });
      continue;
    }
    try {
      const found = await findOrDispatchBackgroundAgent(shell, spawnEnv, sessionCwdFor(agentPath));
      clearAgentUntrusted(sessionCwdFor(agentPath)); // also covers "was already alive"
      logStuckWatchdog(`untrusted: ${name} started after trust -> ${found.id}`);
      results.push({ agentPath, name, ok: true, id: found.id });
    } catch (e) {
      logStuckWatchdog(`untrusted: ${name} still failed after trust: ${e.message}`);
      results.push({ agentPath, name, ok: false, error: e.message, untrusted: !!e.untrusted });
    }
    if (i < targets.length - 1) await new Promise((resolve) => setTimeout(resolve, ENSURE_AGENTS_ALIVE_STAGGER_MS));
  }
  sendUntrustedAgents();
  return { ok: results.every((r) => r.ok), verified: trustResult.verified, backupPath: trustResult.backupPath, results };
});

// --- Always-on background agents (2026-09-20) ------------------------------
// Iddo's requirement: agents must be able to reach each other via
// SendMessage/ListAgents even when one hasn't been opened in Agent Desktop
// for a day or two - a hard need for the planned COO agent, which will need
// to reach every other agent on its own initiative, not only ones with a
// chat tab already open. Confirmed cross-session messaging discovers a "bg"
// peer purely by whether a `claude --bg` process is currently running for
// that cwd - NOT by whether Agent Desktop has an attached pty/chat-view for
// it (~/.claude/daemon/pty-pids/*.pid and daemon.log's "bg spawned"/"bg
// settled" lines are written by the CLI's own shared daemon for every --bg
// dispatch, independent of any attach). So the fix is simply making sure
// every configured agent's `claude --bg` process is dispatched and stays
// alive - deliberately NOT also attaching an interactive pty
// (startTerminalSession's job, only when a chat tab is actually opened), so
// this stays cheap: one background CLI process per agent, no ConPTY/terminal
// overhead until Iddo opens it.
//
// This does NOT extend the stuck-turn/halted-turn watchdogs above, which key
// off ptySessions (the attached view) specifically - that remains the
// documented limitation it always was for an agent whose tab was never
// opened this run.
//
// An "always keep everything alive" sweep would otherwise fight any
// deliberate stop (a runaway/looping agent, a project on hold, freeing up
// the machine for something heavy) - resurrecting it within one sweep
// interval, with delete-agent as the only escape. Fixed by the `paused` flag
// (agents.js setAgentPaused(), set via the "set-agent-paused" IPC handler
// above delete-agent): this sweep skips any agent with it set.
// v1.54.4 self-heal for the duplicate race above, in case one ever slips
// through: when one agent folder has more than one live background process,
// stop the extras that have never written a transcript (an empty copy holds
// no conversation, so stopping it loses nothing). A copy WITH a transcript is
// never touched - two real conversations are logged for a human instead.
// Skips a folder dispatched within the grace window (its new copy may not
// have written its first line yet).
async function stopEmptyDuplicateAgents(shell, spawnEnv, agentsToCheck) {
  const all = await listBackgroundAgents(shell, spawnEnv);
  for (const agent of agentsToCheck) {
    const sessionCwd = sessionCwdFor(agent.path);
    if (dispatchedRecently(sessionCwd)) continue;
    const target = path.resolve(sessionCwd);
    const live = all.filter((a) => a.kind === "background" && a.pid && path.resolve(a.cwd || "") === target);
    if (live.length < 2) continue;
    const projDir = path.join(app.getPath("home"), ".claude", "projects", encodeProjectPath(sessionCwd));
    const hasTranscript = (a) => {
      try {
        return fs.statSync(path.join(projDir, (a.sessionId || a.id) + ".jsonl")).size > 0;
      } catch (e) {
        return false;
      }
    };
    const real = live.filter(hasTranscript);
    const empty = live.filter((a) => !hasTranscript(a));
    // Keep at least one: if none has a transcript yet, keep the newest.
    if (!real.length) empty.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).shift();
    for (const dup of empty) {
      try {
        await runClaudeCommand(shell, ["stop", dup.id], { env: spawnEnv, timeoutMs: CLAUDE_CLI_TIMEOUT_MS });
        logStuckWatchdog(`stopEmptyDuplicateAgents: ${agent.folderName} had ${live.length} live copies - stopped empty duplicate ${dup.id}`);
      } catch (e) {
        logStuckWatchdog(`stopEmptyDuplicateAgents: ${agent.folderName} stop ${dup.id} failed: ${e.message}`);
      }
    }
    if (real.length > 1) {
      logStuckWatchdog(`stopEmptyDuplicateAgents: ${agent.folderName} has ${real.length} live copies WITH conversations (${real.map((a) => a.id).join(", ")}) - left alone, needs a human`);
    }
  }
}

const ENSURE_AGENTS_ALIVE_INTERVAL_MS = 15 * 60 * 1000;
const ENSURE_AGENTS_ALIVE_STAGGER_MS = 2000; // don't launch every configured agent's CLI process in the same instant
// `progress` (optional) is the startup countdown's hook - see startupProgress.
// Returns { measured: true } only when it actually walked the agent list, so
// the caller can tell a real sweep from a skipped/failed one.
async function ensureAllAgentsBackgrounded(progress) {
  // Tier 1/2 sandboxes must never dispatch a real `claude --bg` process: that
  // spends real quota and, in a fixtures-only sandbox, there is nothing for a
  // live process to do anyway. Tier 3 turns it on explicitly, and stops again
  // by itself once the token budget is gone.
  if (!testMode.liveAgentsPermitted()) {
    logStuckWatchdog(`ensureAllAgentsBackgrounded: skipped - ${testMode.describe()}`);
    return { measured: false };
  }
  let agents;
  try {
    agents = listAgents();
  } catch (e) {
    logStuckWatchdog(`ensureAllAgentsBackgrounded: listAgents failed: ${e.message}`);
    return { measured: false };
  }
  const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
  const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", ...CLAUDE_AUTOUPDATER_DISABLE_ENV };
  // Paused agents are skipped (Iddo explicitly stopped them - see
  // set-agent-paused above), so they are left out of the countdown's total too.
  const toCheck = agents.filter((agent) => !agent.paused);
  await stopEmptyDuplicateAgents(shell, spawnEnv, toCheck).catch((e) =>
    logStuckWatchdog(`stopEmptyDuplicateAgents failed: ${e.message}`)
  );
  if (progress) progress.begin(toCheck.length);
  for (let i = 0; i < toCheck.length; i++) {
    const agent = toCheck[i];
    try {
      const sessionCwd = sessionCwdFor(agent.path);
      let alive = await findAliveBackgroundAgent(shell, spawnEnv, sessionCwd);
      if (!alive && dispatchedRecently(sessionCwd)) {
        // v1.54.4: something else (a reset, a chat open, a resume) launched
        // this agent moments ago and `claude agents` doesn't list it yet.
        // Launching again here is exactly how the 09-25 duplicate happened.
        logStuckWatchdog(`ensureAllAgentsBackgrounded: ${agent.folderName} dispatched <${DISPATCH_GRACE_MS / 1000}s ago elsewhere - not dispatching again`);
      } else if (!alive) {
        // An untrusted folder rejects here within a second or two (the trust
        // prompt is caught as it is drawn), is logged by the catch below and
        // still counts as processed for the startup countdown.
        const id = await dispatchBackgroundAgent(shell, spawnEnv, sessionCwd);
        logStuckWatchdog(`ensureAllAgentsBackgrounded: dispatched ${agent.folderName} -> ${id}`);
        alive = await findAliveBackgroundAgent(shell, spawnEnv, sessionCwd); // re-fetch for its full sessionId, below
      } else {
        clearAgentUntrusted(sessionCwd); // running now, e.g. Iddo started it by hand
      }
      // 2026-09-20: Iddo's ask, after the Trade Show agent reported "no
      // Product Development agent is running" - confirmed live it actually
      // WAS running the whole time, just under a cross-session name
      // ("subscription tier migration") that reflected its current
      // conversation topic, not which configured agent it is. Claude
      // Code's own SendMessage/ListAgents match by exact name, so a
      // perfectly live, reachable agent was invisible to a peer searching
      // for it by role. Pin the cross-session-visible name to the agent's
      // own folder name every sweep - overwrites whatever topical title the
      // conversation itself accumulated, deliberately: reliable agent-to-
      // agent addressability matters more here than a descriptive title
      // (Iddo already identifies each agent by its own sidebar tab, not by
      // this name).
      if (alive && alive.sessionId) {
        try {
          setConversationTitle(sessionCwd, alive.sessionId, agent.folderName);
        } catch (e) {
          /* non-fatal - a rename failure shouldn't stop the alive-check sweep */
        }
      }
    } catch (e) {
      // One agent's own hiccup must never block the rest of the sweep.
      logStuckWatchdog(`ensureAllAgentsBackgrounded: ${agent.folderName} failed: ${e.message}`);
    }
    if (progress) progress.agentDone(agent.displayName || agent.folderName);
    // The stagger only separates one agent's CLI launch from the next, so
    // there is nothing to wait for after the last one (it used to add a dead
    // 2 s to every sweep, which the startup countdown would now show).
    if (i < toCheck.length - 1) await new Promise((resolve) => setTimeout(resolve, ENSURE_AGENTS_ALIVE_STAGGER_MS));
  }
  return { measured: true };
}

// The 15-minute sweep above pins each agent's cross-session name once per
// pass, but cannot hold it: Claude Code's own auto-namer re-derives a topical
// name from the conversation and appends a fresh agent-name record whenever
// the conversation moves on, and the last record wins. That is what made the
// Product Development Agent invisible to the Trade Show agent on 2026-09-20 -
// live and reachable the whole time, but listed as "subscription tier
// migration", so a peer looking for it by role found nothing and silently
// took its "agent not reachable" fallback path instead of messaging it.
//
// This reclaims the name roughly once a minute. It is deliberately cheap and
// fully synchronous-filesystem: no CLI process, no transcript parsing, one
// stat per quiet agent per pass (see repinAgentName()'s own comments).
const REPIN_AGENT_NAMES_INTERVAL_MS = 60 * 1000;
function repinAllAgentNames() {
  let agents;
  try {
    agents = listAgents();
  } catch (e) {
    return; // the alive-sweep logs listAgents failures already; don't double-log every minute
  }
  for (const agent of agents) {
    if (agent.paused) continue; // deliberately stopped - leave its conversation alone
    try {
      const result = repinAgentName(sessionCwdFor(agent.path), agent.folderName);
      if (result) {
        // result.from is null when the tail held no agent-name at all (a fresh
        // conversation, or one whose naming records predate the tail window).
        logStuckWatchdog(
          result.from === null
            ? `repinAgentNames: ${agent.folderName} pinned (no prior name in transcript tail)`
            : `repinAgentNames: ${agent.folderName} renamed back from "${result.from}"`
        );
      }
    } catch (e) {
      logStuckWatchdog(`repinAgentNames: ${agent.folderName} failed: ${e.message}`);
    }
  }
}

// --- Tier 3 token budget ----------------------------------------------------
// Iddo's condition for letting the sandbox run a real agent: "use this testing
// agent very conservatively - maybe limit its token use and ask me when it
// exceeds a certain low amount." Enforced mechanically rather than left to the
// agent's own judgement, because the whole risk is an unattended loop nobody
// is watching.
//
// Stopping is done by pausing each sandbox agent (the same `paused` flag the
// keep-alive sweep already respects) AND stopping its background process, so
// nothing restarts it a sweep later. Iddo raises the budget or clears the
// pause himself - the instance never un-pauses itself.
const TEST_BUDGET_CHECK_INTERVAL_MS = 60 * 1000;
let testBudgetWarned = false;
let testBudgetStopped = false;

function notifyTestBudget(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("test-budget-status", { title, body });
  }
}

async function enforceTestTokenBudget() {
  if (!testMode.TEST_MODE || !testMode.ALLOW_LIVE_AGENTS) return;
  let status;
  try {
    status = testMode.budgetStatus();
  } catch (e) {
    return;
  }

  if (status.state === "warn" && !testBudgetWarned) {
    testBudgetWarned = true;
    const pct = Math.round(status.fraction * 100);
    logStuckWatchdog(`test budget at ${pct}% (${status.billable}/${status.budget} tokens)`);
    notifyTestBudget(
      "Sandbox at " + pct + "% of its token budget",
      `${status.billable.toLocaleString()} of ${status.budget.toLocaleString()} tokens used.`
    );
  }

  if (status.state === "exceeded" && !testBudgetStopped) {
    testBudgetStopped = true;
    logStuckWatchdog(
      `test budget EXCEEDED (${status.billable}/${status.budget} tokens) - pausing every sandbox agent`
    );
    let paused = 0;
    try {
      for (const agent of listAgents()) {
        try {
          setAgentPaused(agent.path, true);
          await stopBackgroundAgentForCwd(sessionCwdFor(agent.path));
          paused += 1;
        } catch (e) {
          logStuckWatchdog(`test budget: could not stop ${agent.folderName}: ${e.message}`);
        }
      }
    } catch (e) {
      logStuckWatchdog(`test budget: listAgents failed while stopping: ${e.message}`);
    }
    notifyTestBudget(
      "Sandbox stopped - token budget reached",
      `${status.billable.toLocaleString()} tokens used (budget ${status.budget.toLocaleString()}). ` +
        `${paused} agent(s) paused. Ask Iddo before raising AGENT_DESKTOP_TEST_TOKEN_BUDGET.`
    );
  }
}

// Returns { id, freshlyDispatched } rather than a bare id - startTerminalSession
// uses freshlyDispatched to know whether this is a brand-new bg process (needs
// registerRemoteControl(), below) or one it's simply reattaching to (already
// registered, if it ever was, back when IT was first dispatched).
async function findOrDispatchBackgroundAgent(shell, spawnEnv, sessionCwd) {
  let existing = await findAliveBackgroundAgent(shell, spawnEnv, sessionCwd);
  // v1.54.4: launched moments ago by something else but not listed yet - give
  // it up to ~10 s to show up before launching a second copy.
  for (let i = 0; !existing && i < 5 && dispatchedRecently(sessionCwd); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    existing = await findAliveBackgroundAgent(shell, spawnEnv, sessionCwd);
  }
  if (existing) return { id: existing.id, freshlyDispatched: false };
  const id = await dispatchBackgroundAgent(shell, spawnEnv, sessionCwd);
  return { id, freshlyDispatched: true };
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
  // Never in a test instance. This enumerates every claude process on the
  // machine and kills any pty-host missing from ITS OWN agent roster - which
  // in a sandbox is a different roster, so "unrecognised" would mean Iddo's
  // real agents. There is deliberately no env var to turn this back on.
  if (!testMode.processReapingPermitted()) return;
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

// Mitigation for a confirmed upstream Claude Code CLI bug (see
// agent-desktop\CLAUDE.md, "ROOT CAUSE FOUND for the session wedged solid
// mystery", 2026-09-16): the `--bg` + attach code path can leave the CLI's
// own process alive and "Responding: true" at the OS level, but internally
// stalled mid-turn forever - proven with a minimal repro outside this app
// entirely (main.js/Agent Desktop is not the cause and cannot patch the
// real bug). handlePtyExit()'s existing silent-reattach only fires once the
// process has actually died, so it never catches this - the process never
// dies, it just stops making progress. This watchdog catches the
// "alive but not progressing" case specifically and forces the recovery a
// human would otherwise have to do by hand (confirmed live, repeatedly,
// the same night this was written: killing the stuck process and
// redispatching fresh reliably gets a working session again for a while).
//
// Deliberately cheap per check - getSessionActivity() already does the
// real "is it actually alive" liveness check via a pid-file existence +
// signal-0 probe (no process enumeration), and getLatestTranscriptMtimeMs()
// is a plain fs.statSync, no JSON parsing. Safe to run every 30s even with
// several agents open.
const STUCK_CHECK_INTERVAL_MS = 30 * 1000;

// --- Global auth-failure watchdog (2026-09-20) -----------------------------
// Root cause of the incident this fixes: the CLI's own shared background
// daemon proactively refreshes the OAuth login on a self-scheduled timer
// (see ~/.claude/daemon.log: repeated "auth: proactive refresh succeeded").
// Overnight, one such refresh genuinely failed ("proactive refresh failed,
// signalling re-auth required") - the daemon has no way to reach a human, so
// it just wrote the login out as empty tokens and quietly polled the OS
// keychain every 30s waiting for someone to run `claude auth login`, forever
// if nobody happened to notice. Every claude --bg agent then failed EVERY
// turn instantly with authentication_failed - the Trade Show agent sat like
// that for ~7 hours until Iddo noticed it wasn't responding.
// checkForHaltedTurns() (below) only ever notices this via a given agent's
// OWN transcript, and only for agents already attached in ptySessions this
// run - so an agent that never tried a message, or was never opened this
// run, gave zero signal. This check is independent of both: it reads the
// shared credentials file directly on the same 30s timer, so it fires within
// seconds of the break no matter which (if any) agent tab is open, and
// re-notifies periodically (not every 30s - that would be pure noise) for as
// long as it stays broken, since a single dismissed toast is easy to miss.
const AUTH_RENOTIFY_INTERVAL_MS = 15 * 60 * 1000;
let authWasBroken = false;
let lastAuthNotifiedAt = 0;

function isCredentialsFileBroken() {
  try {
    const credPath = path.join(require("os").homedir(), ".claude", ".credentials.json");
    const oauth = JSON.parse(fs.readFileSync(credPath, "utf-8")).claudeAiOauth;
    // Confirmed broken-state signature from the real incident: accessToken
    // and refreshToken both wiped to "", expiresAt reset to 0.
    return !oauth || !oauth.accessToken || !oauth.refreshToken;
  } catch (e) {
    return false; // missing/unreadable file isn't this signature - don't false-alarm
  }
}

function checkForAuthFailure() {
  const broken = isCredentialsFileBroken();
  if (!broken) {
    if (authWasBroken) logStuckWatchdog("auth: credentials recovered - login restored");
    authWasBroken = false;
    return;
  }
  const now = Date.now();
  if (authWasBroken && now - lastAuthNotifiedAt < AUTH_RENOTIFY_INTERVAL_MS) return;
  authWasBroken = true;
  lastAuthNotifiedAt = now;
  logStuckWatchdog("auth: credentials.json is in the logged-out state - every agent will fail instantly until re-login");
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "Claude Code login expired - ALL agents are down",
        body: "Not a usage limit. Run `claude auth login` from a terminal (or the claude.exe path if `claude` isn't on PATH), then Restart Session on each agent.",
      });
      n.on("click", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      n.show();
    }
  } catch (e) {
    /* a notification failure must never break the watchdog itself */
  }
}
// How long a turn can show zero new transcript bytes, while confirmed
// "working" AND confirmed alive, before it's treated as stuck rather than
// just a genuinely slow single tool call or thinking step. Tuned against
// real data from the same investigation: every confirmed real wedge sat at
// exactly 0 bytes of growth for 100s-500+s; ordinary turns (including a
// slow multi-part Bash call) kept producing new transcript entries at least
// every 10-60s. 3 minutes gives real slow turns comfortable headroom while
// still recovering well before a human would likely have noticed and acted
// manually.
const STUCK_TURN_THRESHOLD_MS = 3 * 60 * 1000;
// If recovery itself doesn't hold (the same session wedges again shortly
// after a fresh redispatch - also observed the same night), this used to
// stop auto-recovering after 3 recoveries per 15-minute window and leave the
// agent stuck for a human to notice and manually restart. Changed 2026-09-17
// (Iddo, after the watchdog left an agent dead for 3+ hours overnight and
// manual "Restart Session" clicks landed in the same doomed loop): a bounded
// recovery cadence (at most one kill/redispatch per STUCK_TURN_THRESHOLD_MS,
// i.e. ~3 min apart) is not a runaway thrash even run forever, so there's no
// good reason to ever stop trying - the alternative is a dead agent nobody
// notices. The count/window tracking is kept purely for visibility (the
// in-terminal notice below reports it) - recovery itself is never gated on it.
const AUTO_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
// Recovery still isn't gated on this - it's just the point past which the
// in-terminal notice adds a louder "this keeps happening" warning, since a
// handful of recoveries in a window is normal noise but double digits means
// something worth a human's attention even though the watchdog is coping.
const MAX_VISIBLE_RECOVERIES_BEFORE_WARNING = 3;

// Deliberately NOT stored on the ptySessions entry itself: recoverStuckSession()
// kills the old session object and startTerminalSession() creates a brand
// new one for the fresh process, which would silently reset any counter
// kept there - defeating the point of tracking recoveries across redispatches.
const autoRecoveryTracking = new Map(); // agentPath -> { windowStart, count }

// Found live 2026-09-17 debugging why recovered sessions kept accumulating
// as zombies: `session.proc.kill()` only signals the top-level pty-hosted
// process (`claude.exe --bg-pty-host ...`), but that process spawns the
// actual `--resume` worker as its own OS child - Windows does not kill
// children when a parent dies unless they're grouped in a job object with
// KILL_ON_JOB_CLOSE, which node-pty's winpty backend here doesn't set up.
// So a "successful" kill left the real worker alive and still burning API
// calls/CPU, un-tracked, while a fresh redispatch started on top of it -
// confirmed live: after one recovery cycle, both the pre-recovery and
// post-recovery worker PIDs were simultaneously alive. `taskkill /T` kills
// the whole process tree, not just the one PID, which is what's actually
// needed here.
//
// CORRECTED same night, after Iddo reported the whole app itself froze and
// had to be closed and reopened: the first version of this used
// execFileSync, which runs synchronously ON THE MAIN PROCESS'S ONLY THREAD -
// if `taskkill` itself ever stalled (e.g. an unresponsive target process),
// it would freeze all of Agent Desktop, not just the one agent being
// recovered - every IPC call, every window, everything, exactly matching
// what Iddo hit. Switched to the async `execFile` with an explicit timeout
// so a slow/stuck taskkill can never block anything else, and made this
// fire-and-forget (recovery already doesn't wait for the OS-level kill to
// fully land before redispatching - same as the pre-existing session.proc.kill()
// call this replaced never did either).
function killProcessTree(proc) {
  if (!proc) return;
  try {
    proc.kill();
  } catch (e) {
    /* fall through to the tree-kill below regardless */
  }
  if (process.platform === "win32" && proc.pid) {
    execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => {
      /* best-effort cleanup - nothing more to do whether it succeeded, the
         process was already gone, or it timed out */
    });
  }
}

const STUCK_WATCHDOG_LOG_PATH = path.join(app.getPath("userData"), "stuck-turn-watchdog.log");
function logStuckWatchdog(line) {
  try {
    fs.appendFileSync(STUCK_WATCHDOG_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    /* logging itself must never be why the watchdog fails */
  }
}

async function recoverStuckSession(agentPath, session, recoveryCount) {
  const { sessionCwd, cols, rows } = session;
  logStuckWatchdog(
    `recovering agentPath=${agentPath} - no transcript growth for ${STUCK_TURN_THRESHOLD_MS / 1000}s while working+alive ` +
      `(recovery #${recoveryCount} in current ${AUTO_RECOVERY_WINDOW_MS / 60000}min window)`
  );
  killProcessTree(session.proc);
  // Same synchronous-placeholder-then-await pattern the start-terminal IPC
  // handler uses (see its own comment) - closes the exact "no session
  // object at all" input-loss window that pattern was built to fix, which
  // would otherwise briefly reopen here between the kill and the new
  // dispatch actually landing.
  ptySessions.set(agentPath, { starting: true, pendingInput: [] });
  try {
    await startTerminalSession(agentPath, sessionCwd, cols, rows);
    logStuckWatchdog(`recovery dispatched OK for agentPath=${agentPath}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const extra =
        recoveryCount > MAX_VISIBLE_RECOVERIES_BEFORE_WARNING
          ? ` This has now happened ${recoveryCount} times in the last ${AUTO_RECOVERY_WINDOW_MS / 60000} min - ` +
            `if it keeps recurring, this agent's session may need a Reset Session (real /clear) or a fresh "+ New chat".`
          : "";
      mainWindow.webContents.send("terminal-data", {
        agentPath,
        data:
          "\r\n\x1b[33m[Agent Desktop: this session showed no progress for a while and appeared frozen - " +
          `automatically restarted (recovery #${recoveryCount}). Known upstream Claude Code issue, see ` +
          `agent-desktop\\CLAUDE.md.${extra}]\x1b[0m\r\n\r\n`,
      });
    }
  } catch (e) {
    ptySessions.delete(agentPath);
    logStuckWatchdog(`recovery dispatch FAILED for agentPath=${agentPath}: ${e.message}`);
  }
}

async function checkForStuckTurns() {
  for (const [agentPath, session] of ptySessions) {
    if (!session || session.starting || !session.proc) continue; // nothing real to check yet
    let activity;
    try {
      activity = getSessionActivity(session.sessionCwd);
    } catch (e) {
      continue; // never let a read failure here affect anything else
    }
    if (!activity || !activity.working) {
      // Not working (or the pid-liveness check inside getSessionActivity
      // already caught it as dead) - nothing to watch right now.
      session.stuckWatch = null;
      continue;
    }

    const mtimeMs = getLatestTranscriptMtimeMs(session.sessionCwd);
    if (mtimeMs == null) continue;

    if (!session.stuckWatch || session.stuckWatch.mtimeMs !== mtimeMs) {
      // Either the first time we've seen this agent working, or real new
      // content landed since the last check - (re)start the clock.
      session.stuckWatch = { mtimeMs, sinceTs: Date.now() };
      continue;
    }

    const stuckForMs = Date.now() - session.stuckWatch.sinceTs;
    if (stuckForMs < STUCK_TURN_THRESHOLD_MS) continue;

    const now = Date.now();
    let tracking = autoRecoveryTracking.get(agentPath);
    if (!tracking || now - tracking.windowStart > AUTO_RECOVERY_WINDOW_MS) {
      tracking = { windowStart: now, count: 0 };
      autoRecoveryTracking.set(agentPath, tracking);
    }
    tracking.count++;
    session.stuckWatch = null;
    // No cap: always recover. STUCK_TURN_THRESHOLD_MS already bounds this to
    // at most one kill/redispatch roughly every 3 minutes per agent, so even
    // a persistently-doomed session just costs a bounded, visible retry
    // cadence rather than being silently abandoned (see 2026-09-17 note above).
    await recoverStuckSession(agentPath, session, tracking.count);
  }
}

// --- rate-limit halt watchdog ----------------------------------------------
// Built 2026-09-17 after the exact gap it fixes: the Trade Show Agent hit the
// account's shared 5-hour usage window mid-turn (answering a plain "Are you
// working on it?"), the CLI wrote back a synthetic rate_limit halt, and
// nothing surfaced it anywhere - no notification, no badge, just a session
// that looked "idle" (correctly, per getSessionActivity's rules - the turn
// really did stop) with no way to tell that from ordinary rest. On the
// desktop Claude.ai app a session limit shows as a visible message; Agent
// Desktop had no equivalent at all. Iddo's ask was explicit: surface it, and
// don't require a human to notice and retype something once the window
// clears - auto-continue on its own.
//
// Distinguishes a *halt* from a *stuck* turn (the watchdog above): a stuck
// turn is a frozen process that never finished; a halt is a turn that
// finished normally, just with an error as its content. Same 30s cadence,
// same ptySessions scope, but reads getHaltInfo() instead of transcript
// mtime, and reacts by notifying + scheduling a resume rather than
// kill+redispatch (killing here would be pointless - the process isn't
// frozen, it's correctly idle waiting for the window to clear).
//
// Wait past the reported resetsAt rather than dispatching exactly on it -
// Anthropic's own reset boundary is a rolling window edge, not a hard
// instant guarantee the very next call succeeds.
const RATE_LIMIT_AUTO_CONTINUE_BUFFER_MS = 90 * 1000;
const AUTO_CONTINUE_PROMPT =
  "The Claude usage limit that stopped this turn has now reset - please continue from exactly where you left off.";

// Transient server errors (2026-09-22). A 500 from Anthropic's API ends the
// turn exactly like a rate limit does, but nothing resumed it: the
// auto-continue above waits for a `resetsAt`, and a 5xx has none, so the turn
// simply sat dead. Iddo's message that morning was never answered and he only
// found out because he asked why the agent had "reached its limit".
//
// Retried rather than just reported because a 5xx usually succeeds on the next
// attempt - but deliberately narrow: ONLY kind==="server_error". An auth
// failure retries forever without a re-login, a rate limit needs its window,
// and an unrecognised error may be permanently malformed, so none of those are
// retried here.
const SERVER_ERROR_RETRY_DELAY_MS = 45 * 1000;   // let the blip pass first
const SERVER_ERROR_RETRY_PROMPT =
  "The previous turn stopped on a transient API error before you could reply - " +
  "please carry on from exactly where you left off.";

// Loop protection, and the reason this is not just a counter on haltTracking.
// haltTracking is keyed by the halt entry's TIMESTAMP, so if a retry itself
// fails with a fresh 500 that is a new timestamp, a new tracking object, and a
// counter reset - which would retry forever during a real outage. This budget
// is keyed by agent and survives new halts; it is cleared only when the agent
// actually completes a turn (see checkForHaltedTurns).
const SERVER_ERROR_RETRY_WINDOW_MS = 30 * 60 * 1000;
const SERVER_ERROR_MAX_RETRIES = 3;
const serverRetryBudget = new Map(); // agentPath -> { count, since }

// haltTracking is in-memory, so after an app restart every existing halt looks
// new and would be retried ~45s later. Resuming this morning's dead turn is
// exactly what we want; silently resurrecting a three-day-old one across every
// agent at once is not. Past this age the banner still explains the error and
// invites a resend - it just is not done automatically.
const SERVER_ERROR_MAX_HALT_AGE_MS = 2 * 60 * 60 * 1000;

function takeServerRetryBudget(agentPath) {
  const now = Date.now();
  let b = serverRetryBudget.get(agentPath);
  if (!b || now - b.since > SERVER_ERROR_RETRY_WINDOW_MS) {
    b = { count: 0, since: now };
    serverRetryBudget.set(agentPath, b);
  }
  if (b.count >= SERVER_ERROR_MAX_RETRIES) return 0;
  b.count += 1;
  return b.count;
}

// agentPath -> { timestamp (of the halt entry being tracked), notified, autoContinued }
// Keyed off the halt entry's own timestamp so a NEW halt (a fresh rate-limit
// hit after a successful resume) is treated as a fresh event needing its own
// notification/auto-continue, not swallowed as "already handled."
const haltTracking = new Map();

function notifyHalt(agentPath, halt) {
  const agentName = path.basename(agentPath);
  if (halt.error === "authentication_failed") {
    try {
      if (Notification.isSupported()) new Notification({ title: `${agentName}: Claude login expired`, body: "Not a usage limit. Run `claude /login` in a terminal, then Restart Session." }).show();
    } catch (e) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", { agentPath, data: "\r\n\x1b[31m[Agent Desktop: this session's Claude login expired (authentication_failed) - NOT a usage limit. Run `claude /login` in a terminal, then Restart Session.]\x1b[0m\r\n\r\n" });
    }
    return;
  }
  if (halt.kind === "server_error") {
    // Not a quota - do not say "usage limit" here either (the banner used to,
    // and it sent Iddo looking for a reset time that did not exist).
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: `${agentName}: API error ${halt.apiErrorStatus || "5xx"}`,
          body: "Not a usage limit. Usually transient.",
        }).show();
      }
    } catch (e) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Deliberately does not promise a retry: this fires the moment the halt
      // is seen, before the age check and the retry budget have had their say.
      // The retry announces itself separately when it actually happens.
      mainWindow.webContents.send("terminal-data", {
        agentPath,
        data:
          `\r\n\x1b[33m[Agent Desktop: this turn stopped on an API error ` +
          `(${halt.apiErrorStatus || "5xx"}) - NOT a usage limit. Usually transient.]\x1b[0m\r\n\r\n`,
      });
    }
    return;
  }
  const resetTime = halt.resetsAt ? new Date(halt.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const resetText = resetTime ? `auto-resumes around ${resetTime}` : "no reset time reported - will need a manual message";

  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `${agentName}: usage limit hit`,
        body: `${halt.rateLimitType || "Usage"} limit reached - ${resetText}.`,
      });
      n.on("click", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      n.show();
    }
  } catch (e) {
    /* a notification failure must never break the watchdog itself */
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal-data", {
      agentPath,
      data:
        `\r\n\x1b[33m[Agent Desktop: this session hit its Claude usage limit (${halt.rateLimitType || "rate_limit"}) and stopped. ` +
        (resetTime ? `It will auto-continue once the window resets around ${resetTime}.]` : `No reset time was reported - send it a message to continue.]`) +
        `\x1b[0m\r\n\r\n`,
    });
  }
}

// Mirrors renderer.js's submitToAgent() exactly, including its own hard-won
// finding (see that function's comment): writing a composed message and its
// trailing "\r" as one fast synchronous pty write gets misread by Claude
// Code's CLI as pasted content rather than typed-text-then-Enter and never
// actually submits. The ~80ms gap before the Enter keystroke is what makes
// real submission happen.
function autoContinueSession(agentPath, session, halt) {
  logStuckWatchdog(
    `auto-continuing agentPath=${agentPath} after rate-limit reset (resetsAt=${halt.resetsAt ? new Date(halt.resetsAt).toISOString() : "unknown"})`
  );
  try {
    session.proc.write(AUTO_CONTINUE_PROMPT);
    setTimeout(() => {
      try {
        session.proc.write("\r");
      } catch (e) {
        logStuckWatchdog(`auto-continue Enter write FAILED for agentPath=${agentPath}: ${e.message}`);
      }
    }, 80);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", {
        agentPath,
        data: `\r\n\x1b[36m[Agent Desktop: usage window reset - automatically resuming this session.]\x1b[0m\r\n\r\n`,
      });
    }
  } catch (e) {
    logStuckWatchdog(`auto-continue write FAILED for agentPath=${agentPath}: ${e.message}`);
  }
}

// Same pty-write shape as autoContinueSession() above, including the 80ms gap
// before Enter that makes the CLI treat this as typed input rather than a
// paste. `attempt` is only for the log and the on-screen notice - the budget
// itself lives in serverRetryBudget.
function retryAfterServerError(agentPath, session, halt, attempt) {
  logStuckWatchdog(
    `retrying agentPath=${agentPath} after API ${halt.apiErrorStatus || "5xx"} ` +
      `(attempt ${attempt}/${SERVER_ERROR_MAX_RETRIES}, halt at ${halt.timestamp})`
  );
  try {
    session.proc.write(SERVER_ERROR_RETRY_PROMPT);
    setTimeout(() => {
      try {
        session.proc.write("\r");
      } catch (e) {
        logStuckWatchdog(`server-error retry Enter write FAILED for agentPath=${agentPath}: ${e.message}`);
      }
    }, 80);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", {
        agentPath,
        data:
          `\r\n\x1b[36m[Agent Desktop: retrying after the API error ` +
          `(attempt ${attempt} of ${SERVER_ERROR_MAX_RETRIES}).]\x1b[0m\r\n\r\n`,
      });
    }
  } catch (e) {
    logStuckWatchdog(`server-error retry write FAILED for agentPath=${agentPath}: ${e.message}`);
  }
}

async function checkForHaltedTurns() {
  for (const [agentPath, session] of ptySessions) {
    if (!session || session.starting || !session.proc) continue;

    let activity;
    try {
      activity = getSessionActivity(session.sessionCwd);
    } catch (e) {
      continue;
    }
    if (activity && activity.working) {
      // A fresh turn is running - any halt tracked before this is stale.
      haltTracking.delete(agentPath);
      continue;
    }

    let halt;
    try {
      halt = getHaltInfo(session.sessionCwd);
    } catch (e) {
      continue;
    }
    if (!halt) {
      // No halt is the end of the story: the agent replied normally (or the
      // user sent something new), so a past run of server errors is over and
      // its retry budget should not count against a future, unrelated one.
      haltTracking.delete(agentPath);
      serverRetryBudget.delete(agentPath);
      continue;
    }

    let tracking = haltTracking.get(agentPath);
    if (!tracking || tracking.timestamp !== halt.timestamp) {
      tracking = { timestamp: halt.timestamp, notified: false, autoContinued: false, firstSeenAt: Date.now() };
      haltTracking.set(agentPath, tracking);
    }

    if (!tracking.notified) {
      tracking.notified = true;
      logStuckWatchdog(
        `halt detected agentPath=${agentPath} error=${halt.error} rateLimitType=${halt.rateLimitType} ` +
          `resetsAt=${halt.resetsAt ? new Date(halt.resetsAt).toISOString() : "unknown"}`
      );
      notifyHalt(agentPath, halt);
    }

    // Transient API error: wait out the blip, then resend once. Guarded by
    // BOTH tracking.autoContinued (one retry per halt entry) and
    // serverRetryBudget (a cap per agent that survives new halt entries, so a
    // real outage stops instead of retrying forever - see its comment above).
    if (halt.kind === "server_error") {
      const haltAge = halt.timestamp ? Date.now() - Date.parse(halt.timestamp) : 0;
      if (haltAge > SERVER_ERROR_MAX_HALT_AGE_MS) {
        tracking.autoContinued = true; // too old to resume on its own; banner still explains it
      }
      if (!tracking.autoContinued && Date.now() - tracking.firstSeenAt >= SERVER_ERROR_RETRY_DELAY_MS) {
        tracking.autoContinued = true;
        const attempt = takeServerRetryBudget(agentPath);
        if (attempt) {
          retryAfterServerError(agentPath, session, halt, attempt);
        } else {
          logStuckWatchdog(
            `NOT retrying agentPath=${agentPath} - ${SERVER_ERROR_MAX_RETRIES} API-error retries already used ` +
              `in the last ${SERVER_ERROR_RETRY_WINDOW_MS / 60000} minutes; leaving it for Iddo`
          );
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("terminal-data", {
              agentPath,
              data:
                `\r\n\x1b[31m[Agent Desktop: the API keeps erroring - stopping automatic retries after ` +
                `${SERVER_ERROR_MAX_RETRIES}. Check https://status.claude.com, then send your message again.]\x1b[0m\r\n\r\n`,
            });
          }
        }
      }
      continue;
    }

    if (!tracking.autoContinued && halt.resetsAt && Date.now() >= halt.resetsAt + RATE_LIMIT_AUTO_CONTINUE_BUFFER_MS) {
      tracking.autoContinued = true;
      autoContinueSession(agentPath, session, halt);
    }
  }
}
// --- end rate-limit halt watchdog -------------------------------------------
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
    const stillAlive = await findAliveBackgroundAgent(session.shell, session.spawnEnv, session.sessionCwd).catch(() => null);
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

// Reads an agent's chosen display name from its agent_config.json, falling
// back to the folder name (the app's oldest agents predate that file - see
// agents.js's loadAgentConfig for the same fallback). Kept local rather than
// importing from agents.js since only the one field is needed here.
function agentDisplayName(agentPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(agentPath, "agent_config.json"), "utf-8"));
    if (cfg && typeof cfg.display_name === "string" && cfg.display_name.trim()) {
      return cfg.display_name.trim();
    }
  } catch (e) {
    /* no/unreadable config - fall through to the folder name */
  }
  return path.basename(agentPath);
}

// When a brand-new background conversation is dispatched for an agent, give
// it a recognizable title right away - "<Agent name> · <YYYY-MM-DD>" -
// instead of leaving it to Claude Code's own auto-generated (and often
// stale) name. This is the title the Chats panel shows and, because this
// runs immediately after registerRemoteControl() made this the live Remote
// Control session, the one claude.ai/code's "Recents" and the mobile app
// read too - so a roster of many agents stays identifiable there without
// renaming each by hand. Best-effort and silent: any failure (or a title
// the user/CLI already set) just leaves the conversation as-is; it never
// blocks the session opening. The <sessionId>.jsonl file exists by now
// because registerRemoteControl() already wrote to the session, but a short
// retry covers the write still settling on disk.
async function autoTitleFreshConversation(agentPath, sessionCwd) {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const convos = listConversations(sessionCwd);
      const current = convos.find((c) => c.isCurrent) || convos[0];
      if (current && current.sessionId) {
        // Never clobber a title someone deliberately set (a user rename, or
        // a resumed conversation that already carried one).
        if (current.titleSource === "custom") return;
        const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, tz-stable enough
        setConversationTitle(sessionCwd, current.sessionId, `${agentDisplayName(agentPath)} · ${stamp}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } catch (e) {
    /* best-effort - a missing auto-title is not worth surfacing or retrying harder */
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
  let freshlyDispatched = false;
  try {
    if (knownAgentId) {
      agentId = knownAgentId;
    } else {
      const found = await findOrDispatchBackgroundAgent(shell, spawnEnv, sessionCwd);
      agentId = found.id;
      freshlyDispatched = found.freshlyDispatched;
    }
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

    // Only for a genuinely new bg process - see registerRemoteControl()'s
    // own comment above for why reattaching to one that's still alive is
    // deliberately skipped (already registered when it was first dispatched).
    if (freshlyDispatched) {
      await registerRemoteControl(proc);
      // Name this fresh conversation after the agent so it's identifiable in
      // the Chats panel and (via the Remote Control registration just done)
      // in claude.ai/code's "Recents" / the mobile app. Awaited so its own
      // JSONL append can't race the permanent onData listener / archive tick
      // attached below, but it's fully self-contained and never throws.
      await autoTitleFreshConversation(agentPath, sessionCwd);
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
      // trailing "\r" must land as two separately-timed writes. Each
      // individual item is itself now chunked if long - see
      // writeToPtyChunked()'s own comment for why a large single write can
      // arrive at the CLI garbled or truncated.
      setTimeout(() => writeToPtyChunked(proc, agentPath, data), i * 80);
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

ipcMain.handle("start-terminal", async (event, { agentPath, cols, rows, knownAgentId }) => {
  if (ptySessions.has(agentPath)) {
    return { alreadyRunning: true };
  }
  // Found by using the sandbox for the first time (2026-09-22): gating the
  // keep-alive sweep was not enough. Opening an agent's tab reaches dispatch
  // by a completely different path, so a single click on a fixture agent
  // would have started a real `claude --bg` against a fake folder and spent
  // real tokens - in the tier that is supposed to spend nothing.
  if (!testMode.liveAgentsPermitted()) {
    const why = testMode.budgetExhausted()
      ? "the sandbox token budget is spent - ask Iddo before raising it"
      : "this sandbox runs on fixtures only; relaunch with `Start-TestDesktop.bat live` to allow a real agent";
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", {
        agentPath,
        data: `\r\n\x1b[33m[Agent Desktop SANDBOX: not starting a Claude process - ${why}.\r\n` +
              `The transcript below is a fixture, so the UI still renders exactly as it would for a real agent.]\x1b[0m\r\n\r\n`,
      });
    }
    return { alreadyRunning: false, testModeBlocked: true, reason: why };
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
    // knownAgentId (set only right after switch-conversation dispatched a
    // specific fresh/resumed session - see the renderer's switchToConversation)
    // skips the normal find-or-dispatch discovery entirely. That discovery
    // picks by --continue's own "most recent conversation with real content"
    // heuristic, which a conversation that was *just* forceFresh-dispatched
    // with zero messages yet doesn't qualify for - confirmed live: a
    // standalone forceFresh dispatch was correctly created and left running,
    // but the very next plain "open this agent" ended up dispatching ANOTHER
    // session and resuming the old conversation instead, never finding the
    // fresh one at all. Passing the id we already know we just created
    // removes the guessing entirely.
    await startTerminalSession(agentPath, sessionCwd, cols, rows, knownAgentId || undefined);
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

ipcMain.handle("get-session-activity", (event, { agentPath }) => getSessionActivity(sessionCwdFor(agentPath)));
// 2026-09-23: how long the agent's transcript has been quiet. The delivery
// check needs this because "is it working" is a heuristic that goes false in
// every gap between two tool calls, while a transcript that is still growing
// is direct evidence the agent is alive and mid-run - and therefore that a
// message sitting unmatched is queued behind that run, not lost.
ipcMain.handle("get-transcript-quiet-ms", (event, { agentPath }) => {
  try {
    const mtime = getLatestTranscriptMtimeMs(sessionCwdFor(agentPath));
    return mtime == null ? null : Math.max(0, Date.now() - mtime);
  } catch (e) {
    return null;
  }
});
// Tasks panel + sidebar state rings (v1.37.0) - see overview.js.
ipcMain.handle("get-agent-overview", () => overview.getAgentOverview(listAgents(), sessionCwdFor));
// ARGUS / the Bridge (v1.39.0) - see argus-data.js. The workspace root, not
// AGENTS_ROOT: in the sandbox the agents are fixtures but the report files are
// real, and they are only ever read here.
const ARGUS_WORKSPACE = "D:\\Dropbox\\Claude stuff";
ipcMain.handle("argus-data", (event, opts) => argus.getArgusData(ARGUS_WORKSPACE, opts || {}));
ipcMain.handle("argus-decision-count", () => argus.getDecisionCount(ARGUS_WORKSPACE));
// Drill-down (v1.42.0): opening the report behind a number. argus-data
// validates the path against the links the status files themselves publish,
// so a renderer cannot ask for an arbitrary file.
ipcMain.handle("argus-open-source", (event, { file }) => argus.openSource(ARGUS_WORKSPACE, file));
// Iddo's verdict on a weekly idea (v1.44.0). The only write path the Argus
// view has into an agent-owned file, and argus-data validates every field
// before touching it - see setIdeaDecision.
ipcMain.handle("argus-set-idea-decision", (event, payload) => argus.setIdeaDecision(ARGUS_WORKSPACE, payload || {}));
// Library tabs (v1.38.0) - see registry.js. Opening is by entry id only.
ipcMain.handle("registry-list", () => registry.listRegistry(AGENTS_ROOT));
ipcMain.handle("registry-action", (event, { id, action }) =>
  ["open", "reveal", "copy", "view", "openPdf"].includes(action)
    ? registry.registryAction(AGENTS_ROOT, String(id || ""), action)
    : { ok: false, error: "Unknown action." });
// Clickable PDF paths in chat bubbles (v1.52.0). The path comes from an
// agent's reply, so registry.openLocalPdf treats it as untrusted: existing
// .pdf files under the workspace or E:\Claude work only; refusals logged.
const PDF_LINK_ROOTS = [ARGUS_WORKSPACE, "E:\\Claude work", AGENTS_ROOT];
const PDF_LINK_LOG = path.join(app.getPath("userData"), "pdf-links.log");
function logPdfLink(line) {
  console.log("[pdf-link] " + line);
  try {
    fs.appendFileSync(PDF_LINK_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    /* logging must never be why a click fails */
  }
}
ipcMain.handle("open-local-pdf", (event, { filePath } = {}) =>
  registry.openLocalPdf(filePath, PDF_LINK_ROOTS, logPdfLink));
ipcMain.handle("approve-telegram-tasks", (event, { ids }) =>
  overview.approveTelegramTasks(ids, path.join(AGENTS_ROOT, "Security", "Tools", "TelegramBridge")));

ipcMain.handle("get-usage-windows", () => getUsageWindows());

// 2026-09-20: renderer.js's PLAN_FIVE_HOUR_ESTIMATES fallback (used only
// when Anthropic's own confirmed rate_limits figure isn't available yet)
// used to depend entirely on a manually-set sidebar dropdown, stored in
// localStorage, with no connection to reality - confirmed live: it was
// still set to "Pro" (45 msgs/5h) hours after Iddo actually upgraded to Max
// 5x (225 msgs/5h), silently showing a ~5x-inflated, falsely alarming
// percentage. infrastructure_facts.md's "Current plan:" line is this
// workspace's single source of truth for exactly this fact (root
// CLAUDE.md: "agent docs must reference it, never restate those facts") -
// so read the plan from there instead of asking Iddo to separately keep a
// second copy of the same fact in sync inside this app. mtime-gated so a
// plain-text file this small still isn't re-read on every single call.
const INFRA_FACTS_PATH = path.join(AGENTS_ROOT, "infrastructure_facts.md");
let infraFactsPlanCache = { mtimeMs: null, planId: null };
function getInferredPlanId() {
  try {
    const mtimeMs = fs.statSync(INFRA_FACTS_PATH).mtimeMs;
    if (infraFactsPlanCache.mtimeMs === mtimeMs) return infraFactsPlanCache.planId;
    const text = fs.readFileSync(INFRA_FACTS_PATH, "utf-8");
    const m = /^-\s*\*\*Current plan:\*\*\s*Claude\s*\*\*([^*]+)\*\*/im.exec(text);
    let planId = null;
    if (m) {
      const label = m[1].trim().toLowerCase();
      if (label === "pro") planId = "pro";
      else if (label.includes("max 5x") || label.includes("max5x")) planId = "max5x";
      else if (label.includes("max 20x") || label.includes("max20x")) planId = "max20x";
    }
    infraFactsPlanCache = { mtimeMs, planId };
    return planId;
  } catch (e) {
    return null; // file missing/unreadable/unparseable - caller falls back to its own stored default
  }
}
ipcMain.handle("get-inferred-plan-id", () => getInferredPlanId());

// 2026-09-20: pairs with renderer.js's rebuildChatView() pendingSent-expiry
// handling - a message that never landed in the transcript within
// PENDING_SENT_TIMEOUT_MS used to just silently vanish from the chat view
// with no signal anywhere. Iddo lost a long, detailed reply to the Trade
// Show agent this way and only noticed because the agent's next reply
// didn't reflect it. This fires an OS notification so a delivery failure is
// visible even if Agent Desktop isn't the focused window at the time.
ipcMain.handle("notify-send-failed", (event, { agentPath, text }) => {
  try {
    if (Notification.isSupported()) {
      const agentName = path.basename(agentPath);
      const preview = (text || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const n = new Notification({
        title: `${agentName}: message not confirmed`,
        body: `It has not appeared in the agent's transcript and the agent has gone quiet - open Agent Desktop and check the conversation before resending. "${preview}${text && text.length > 120 ? "…" : ""}"`,
      });
      n.on("click", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      n.show();
    }
  } catch (e) {
    /* a notification failure must never break anything else */
  }
  logStuckWatchdog(`notify-send-failed: ${agentPath} - message never landed in transcript, re-queued`);
  return { ok: true };
});

// v1.23.0 guards (handoff-reset + usage-limit warnings) - isolated module, loaded
// defensively so a bug there can only disable the guards, never the app.
try {
  require("./guards-main").init({
    ipcMain,
    Notification,
    getMainWindow: () => mainWindow,
    sessionCwdFor,
    archive: require("./archive"),
    log: (line) => logStuckWatchdog(line),
    resolveClaudeExecutable,
  });
} catch (e) {
  console.error("guards-main failed to load:", e);
}

try {
  require("./voice-main").init({ ipcMain, log: (line) => logStuckWatchdog(line) });
} catch (e) {
  console.error("voice-main failed to load:", e);
}

// --- Chats panel (per-agent conversation list / switch / rename) -----------
//
// Each agent's `.claude-session` cwd accumulates one <sessionId>.jsonl per
// distinct conversation (a fresh one on first open, another on every
// /clear). listConversations() turns that pile into a titled list; the
// panel lets the user resume any of them or start a new one - the same
// model as claude.ai/code's "Recents", from the same on-disk data.

ipcMain.handle("list-conversations", (event, { agentPath }) => {
  const sessionCwd = sessionCwdFor(agentPath);
  // Same freshness courtesy as list-archived-days: fold in anything the
  // live session has written since the last 30s archive tick before listing.
  const session = ptySessions.get(agentPath);
  if (session && !session.starting) {
    try {
      syncArchive(agentPath, sessionCwd);
    } catch (e) {}
  }
  return listConversations(sessionCwd);
});

ipcMain.handle("rename-conversation", (event, { agentPath, sessionId, title }) => {
  // Throws (Invalid session id / empty title / file not found) surface to
  // the renderer's catch - see archive.js setConversationTitle().
  return setConversationTitle(sessionCwdFor(agentPath), sessionId, title);
});

// Point this agent's live session at a different past conversation
// (resumeSessionId), or start a brand-new one (newConversation: true).
// Either way the running `claude --bg` process has to be replaced: it's
// bound to whatever conversation it was dispatched with, and only a fresh
// dispatch (`--bg --resume <id>` or `--bg` with no --continue) can change
// that. Tear down the attach pty, stop the bg daemon, dispatch a new one;
// the renderer then re-attaches through its normal start-terminal path.
ipcMain.handle("switch-conversation", async (event, { agentPath, resumeSessionId, newConversation }) => {
  const sessionCwd = sessionCwdFor(agentPath);
  // Drop the ptySessions entry BEFORE killing the pty: proc.onExit ->
  // handlePtyExit checks `if (!session) return` first, so removing it now
  // means the exit won't trigger handlePtyExit's auto-reattach, which would
  // otherwise immediately reconnect to the very conversation we're leaving.
  const live = ptySessions.get(agentPath);
  if (live && !live.starting) {
    if (live.archiveTimer) clearInterval(live.archiveTimer);
    try {
      syncArchive(agentPath, sessionCwd);
    } catch (e) {}
    ptySessions.delete(agentPath);
    try {
      if (live.proc) live.proc.kill();
    } catch (e) {}
  }
  // Stops the underlying `claude --bg` daemon for this cwd and polls until
  // its pid is actually gone (same helper delete-agent uses).
  await stopBackgroundAgentForCwd(sessionCwd);
  const shell = process.platform === "win32" ? resolveClaudeExecutable() : "claude";
  const spawnEnv = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", ...CLAUDE_AUTOUPDATER_DISABLE_ENV };
  const opts = newConversation ? { forceFresh: true } : { resumeSessionId };
  const newId = await dispatchBackgroundAgent(shell, spawnEnv, sessionCwd, opts);
  return { ok: true, agentId: newId };
});

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
// Sent-message log (v1.23.2): a long message once reached the CLI with its head missing and no
// copy existed anywhere to recover it. Every multi-character write to a session is appended here
// BEFORE it goes to the pty, so a cut message can always be recovered/compared. JSONL, rotated at 5 MB.
const SENT_LOG_PATH = path.join(app.getPath("userData"), "sent-messages.jsonl");
function logSentInput(agentPath, data) {
  try {
    if (typeof data !== "string" || data.length < 2) return; // skip lone "\r" / keystrokes
    try {
      if (fs.statSync(SENT_LOG_PATH).size > 5 * 1024 * 1024) fs.renameSync(SENT_LOG_PATH, SENT_LOG_PATH + ".old");
    } catch (e) {}
    // Redact obvious secret shapes (API keys / bearer tokens / key=value secrets); the rest is kept verbatim on purpose.
    const text = data
      .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
      .replace(/(bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi, "$1[REDACTED]")
      .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
    fs.appendFileSync(SENT_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), agent: path.basename(agentPath || ""), len: data.length, text }) + "\n", { mode: 0o600 });
  } catch (e) {}
}

ipcMain.on("terminal-input", (event, { agentPath, data }) => {
  logSentInput(agentPath, data);
  const session = ptySessions.get(agentPath);
  if (!session) {
    // No tracked session at all for this agent (as opposed to the "starting"
    // placeholder case below, which IS tracked and queues correctly) - found
    // 2026-09-17 while investigating a report of a typed message just
    // vanishing with no error and no trace anywhere. Previously this branch
    // silently dropped the input entirely; now it at least surfaces the loss
    // visibly instead of eating it silently, so a future occurrence reads as
    // an obvious error to retry rather than an unexplained disappearance.
    // Root trigger for how ptySessions can lack an entry while the user is
    // still looking at this agent's chat isn't confirmed - flagging rather
    // than guessing further.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-data", {
        agentPath,
        data: "\r\n\x1b[31m[Agent Desktop: this message could not be delivered - no active session found. Please resend.]\x1b[0m\r\n\r\n",
      });
    }
    return;
  }
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
  writeToPtyChunked(session.proc, agentPath, data);
});

// 2026-09-20: root-caused a long-running "long messages arrive garbled or
// truncated" report by checking sent-messages.jsonl (logSentInput, above) -
// the FULL, correct text was already being handed to this handler every
// single time, byte for byte, confirmed on repeated failing attempts. So
// the corruption was never in this app's own code up to this point; it was
// happening downstream of one single large synchronous session.proc.write()
// call, somewhere in node-pty's ConPTY layer or in Claude Code's own stdin
// reading on the other end of the pipe - a large one-shot burst (over
// 2KB in the confirmed failures) apparently doesn't survive intact.
// Mitigation at the time: write it in small chunks with a short delay
// between them instead of one synchronous call.
//
// 2026-09-21 correction (part 1): that diagnosis was half-confounded. A
// second, independent mechanism was ALSO in play - a raw pty write with no
// bracketed-paste marker is exactly what a real terminal never sends for an
// actual paste, so the CLI's own heuristics for telling "one paste" apart
// from "fast individual keystrokes" had nothing to go on. submitToAgent()
// in renderer.js now wraps long sends in the standard \x1b[200~ ... \x1b[201~
// bracketed-paste escape codes for exactly that reason. First attempt at
// this fix made this function do one synchronous proc.write() of the whole
// bracket-wrapped string, no chunking at all, on the theory that the ORIGINAL
// ~2KB failure boundary was entirely a symptom of the missing bracket marker
// and would disappear once that was fixed.
//
// 2026-09-21 correction (part 2, same night): it didn't disappear. Live-
// bisected against the Testing agent post-bracket-paste: 1000/2000/2200
// bytes landed clean, 2500/3000/5866 bytes silently vanished - never reached
// the CLI at all (confirmed via `claude agents --json` showing the process
// idle/done, and the Raw Terminal view showing no trace of the message
// arriving). That boundary lines up almost exactly with the ORIGINAL
// pre-bracket-paste measurement two sections up (~1800 safe / ~2420+ fails),
// which means that measurement was never fully explained by the missing
// bracket marker - there is a genuine separate size ceiling on one raw
// synchronous write to this pty (node-pty's ConPTY layer on Windows, or a
// buffer somewhere in Claude Code's own stdin reading), independent of the
// paste-vs-typing ambiguity bracketed paste addresses. The two bugs happened
// to share the same rough byte count, which is what made this look solved
// after v1.32.0 when it wasn't.
//
// 2026-09-21 correction (part 3, same night): tried chunking at a safe size
// with zero artificial delay (1500-byte pieces via setImmediate, replacing
// the theory above) and re-bisected. It did NOT help - a fresh 2500-char
// message, chunked this way, failed identically to an unchunked one. That
// rules out single-write byte size as the mechanism entirely: however this
// app writes the bytes, in whatever pieces, at whatever cadence, the CLI's
// own reading side still can't handle the same total ~2.2-2.5KB of pasted
// input. This is not fixable from this app's write path - it's a limit on
// Claude Code's own side, outside this repo. The one thing that actually
// worked both nights was never attempting it: `LONG_MESSAGE_FILE_THRESHOLD`
// in renderer.js is now set safely under this boundary (1800), so anything
// long enough to be at risk is written to a file and read instead of typed.
// Back to a single plain write - no chunking, since chunking demonstrably
// doesn't address the real cause and only adds complexity.
function writeToPtyChunked(proc, agentPath, data) {
  try {
    proc.write(data);
  } catch (e) {
    handlePtyExit(agentPath);
  }
}

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

// CPU guard installer (v1.66.0). Installs / checks / removes the per-user scheduled task that runs
// tools/cpuguard/CpuGuard.ps1 (see tools/cpuguard/README.md). Windows only, per-user, no elevation.
//
// Rules (Iddo, 2026-10-03):
//   - ask the user ONCE before installing anything; remember the answer (ui-flags: cpuGuardConsent);
//   - an existing SEC_CpuGuard / AgentDesktop_CpuGuard task that is running means: do nothing;
//   - when the shipped script version differs from what was registered (app update), re-register;
//   - the user can turn it off / on / uninstall at any time (ui-flags: cpuGuardEnabled).
//
// Pure functions (decideEnsure, buildTaskXml, ...) are unit-tested in tests/cpuGuardInstall.test.js.
// The scripts are COPIED to <stateDir>\bin and the task points there, so it works from an asar package and
// survives the app folder moving or being replaced by an update.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const TASK_NAME = "AgentDesktop_CpuGuard";
const LEGACY_TASK_NAMES = ["SEC_CpuGuard"]; // the Security agent's own, hand-made copy on the author's machine
const SHIPPED_FILES = ["CpuGuard.ps1", "RunHidden.vbs", "README.md"];
const STATUS_FRESH_MS = 20000; // status.json is rewritten every ~2 s while the guard runs

function defaultStateDir(env = process.env) {
  const base = env.APPDATA || path.join(env.USERPROFILE || env.HOME || ".", "AppData", "Roaming");
  return path.join(base, "agent-desktop", "cpuguard");
}

// "CPUGUARD_VERSION=2.1" on a line of its own near the top of CpuGuard.ps1.
function parseGuardVersion(scriptText) {
  const m = /^\s*CPUGUARD_VERSION=([0-9][0-9A-Za-z.\-]*)\s*$/m.exec(String(scriptText || ""));
  return m ? m[1] : null;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// The arguments handed to wscript.exe: hidden, RunHidden.vbs, then the script and its parameters.
function buildTaskArguments({ vbs, ps1, stateDir }) {
  return `//B "${vbs}" "${ps1}" -StateDir "${stateDir}"`;
}

function buildTaskXml({ userId, vbs, ps1, stateDir, binDir }) {
  const args = buildTaskArguments({ vbs, ps1, stateDir });
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent Desktop CPU guard: keeps the PC responsive when many agents work at once (lowers agent priority, never closes anything).</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(binDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// existing: [{ name, state }] for tasks that exist (state: "Running" | "Ready" | "Disabled" | ...), registered
// info for OUR task: { args } (its action arguments). Returns what ensureCpuGuard should do.
//   action: "none" | "ask" | "install" | "reinstall" | "start"
function decideEnsure({ platform, testMode, flags = {}, existing = [], wantArgs, shippedVersion }) {
  if (platform !== "win32") return { action: "none", reason: "not Windows" };
  if (testMode) return { action: "none", reason: "test mode" };
  const running = existing.find((t) => /^running$/i.test(t.state || ""));
  const ours = existing.find((t) => t.name === TASK_NAME);
  if (flags.cpuGuardEnabled === false) return { action: "none", reason: "turned off by the user" };
  // Someone else's guard task (the author's SEC_CpuGuard) or ours already running: nothing to do... except
  // our own task still pointing at an old script/path after an update.
  if (running && !(running.name === TASK_NAME && needsReregister(ours, flags, wantArgs, shippedVersion))) {
    return { action: "none", reason: `${running.name} already running` };
  }
  const legacy = existing.find((t) => LEGACY_TASK_NAMES.includes(t.name));
  if (legacy && !ours) {
    // An existing guard that is merely not running right now: leave it to its owner, do not add a second one.
    return { action: "none", reason: `${legacy.name} exists (${legacy.state || "unknown state"})` };
  }
  if (ours) {
    if (needsReregister(ours, flags, wantArgs, shippedVersion)) return { action: "reinstall", reason: "shipped script or path changed" };
    if (/^disabled$/i.test(ours.state || "")) return { action: "none", reason: "task disabled" };
    return { action: "start", reason: "task registered but not running" };
  }
  if (flags.cpuGuardConsent === "yes") return { action: "install", reason: "consented, task missing" };
  if (flags.cpuGuardConsent === "no") return { action: "none", reason: "user said not now" };
  return { action: "ask", reason: "first time" };
}

function needsReregister(ours, flags, wantArgs, shippedVersion) {
  if (!ours) return false;
  if (flags.cpuGuardVersion && shippedVersion && flags.cpuGuardVersion !== shippedVersion) return true;
  if (wantArgs && ours.args && normaliseArgs(ours.args) !== normaliseArgs(wantArgs)) return true;
  return false;
}
function normaliseArgs(a) {
  return String(a).replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------- Windows side effects

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: opts.timeout || 30000, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Locale-proof: the PowerShell cmdlet gives English state names ("Running", "Ready", "Disabled").
async function queryTasks(names = [TASK_NAME, ...LEGACY_TASK_NAMES]) {
  const list = names.map((n) => `'${n}'`).join(",");
  const ps =
    `$o=@(); foreach($n in @(${list})){ $t=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; if($t){ ` +
    `$a=''; try{ $a=[string]$t.Actions[0].Arguments }catch{}; $o+=[pscustomobject]@{name=$t.TaskName;state=[string]$t.State;args=$a} } }; ` +
    `ConvertTo-Json -InputObject @($o) -Compress`;
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 25000 });
  if (!r.ok) return [];
  try {
    const v = JSON.parse(r.stdout.trim() || "[]");
    return Array.isArray(v) ? v : [v];
  } catch (e) {
    return [];
  }
}

function readStatusFile(stateDir) {
  try {
    const f = path.join(stateDir, "state", "status.json");
    const st = fs.statSync(f);
    const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
    return { ...j, ageMs: Date.now() - st.mtimeMs, fresh: Date.now() - st.mtimeMs < STATUS_FRESH_MS };
  } catch (e) {
    return null;
  }
}

function copyShipped(srcDir, binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  for (const f of SHIPPED_FILES) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(binDir, f)); // read through asar works; the copy is a real file
  }
}

function currentUserId(env = process.env) {
  const u = env.USERNAME || "";
  const d = env.USERDOMAIN || env.COMPUTERNAME || "";
  return d ? `${d}\\${u}` : u;
}

// Registers (or replaces) the task and starts it. Returns { ok, error?, version }.
async function installGuard({ srcDir, stateDir, taskName = TASK_NAME, env = process.env, log = () => {} }) {
  const binDir = path.join(stateDir, "bin");
  try {
    copyShipped(srcDir, binDir);
  } catch (e) {
    return { ok: false, error: "copy failed: " + e.message };
  }
  const ps1 = path.join(binDir, "CpuGuard.ps1");
  const vbs = path.join(binDir, "RunHidden.vbs");
  let version = null;
  try { version = parseGuardVersion(fs.readFileSync(ps1, "utf8")); } catch (e) { /* ignore */ }
  const xml = buildTaskXml({ userId: currentUserId(env), vbs, ps1, stateDir, binDir });
  const xmlFile = path.join(stateDir, "task.xml");
  try {
    fs.writeFileSync(xmlFile, "﻿" + xml, "utf16le");
  } catch (e) {
    return { ok: false, error: "could not write task file: " + e.message };
  }
  await run("schtasks.exe", ["/End", "/TN", taskName]); // ignore failure: not running
  await killGuardProcesses(stateDir);
  const c = await run("schtasks.exe", ["/Create", "/TN", taskName, "/XML", xmlFile, "/F"]);
  try { fs.unlinkSync(xmlFile); } catch (e) { /* ignore */ }
  if (!c.ok) {
    log(`cpuguard: schtasks /Create failed: ${(c.stderr || c.stdout).trim().slice(0, 300)}`);
    return { ok: false, error: (c.stderr || c.stdout).trim().slice(0, 300) || "schtasks failed" };
  }
  const s = await run("schtasks.exe", ["/Run", "/TN", taskName]);
  return { ok: true, started: s.ok, version, wantArgs: buildTaskArguments({ vbs, ps1, stateDir }) };
}

// Task Scheduler's /End does not reach the PowerShell grandchild started via wscript, so end it by PID,
// matching only OUR copy (<stateDir>\bin\CpuGuard.ps1) - never another guard (e.g. SEC_CpuGuard) and never by name alone.
async function killGuardProcesses(stateDir) {
  const needle = path.join(stateDir, "bin", "CpuGuard.ps1").replace(/'/g, "''");
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='wscript.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('${needle}', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 })).ok;
}

async function startGuard(taskName = TASK_NAME) {
  return (await run("schtasks.exe", ["/Run", "/TN", taskName])).ok;
}
async function stopGuard(taskName = TASK_NAME, stateDir) {
  await run("schtasks.exe", ["/End", "/TN", taskName]);
  if (stateDir) {
    await killGuardProcesses(stateDir);
    await releaseGuard(stateDir); // resume anything the killed guard had paused
  }
}
async function releaseGuard(stateDir) {
  const ps1 = path.join(stateDir, "bin", "CpuGuard.ps1");
  if (!fs.existsSync(ps1)) return false;
  return (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Mode", "Release", "-StateDir", stateDir], { timeout: 20000 })).ok;
}
async function uninstallGuard(taskName = TASK_NAME, stateDir) {
  await stopGuard(taskName, stateDir);
  const d = await run("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
  return d.ok;
}
async function setTaskEnabled(taskName, on) {
  return (await run("schtasks.exe", ["/Change", "/TN", taskName, on ? "/ENABLE" : "/DISABLE"])).ok;
}

// ctx: { srcDir, stateDir, platform, testMode, getFlags(), setFlag(k,v), askConsent(): Promise<boolean>, log(msg) }
async function ensureCpuGuard(ctx) {
  const { srcDir, stateDir, platform = process.platform, testMode = false, getFlags, setFlag, askConsent, log = () => {}, deps = {} } = ctx;
  const doQuery = deps.queryTasks || queryTasks;
  const doInstall = deps.installGuard || installGuard;
  const doStart = deps.startGuard || startGuard;
  const flags = getFlags() || {};
  let shippedVersion = null;
  try { shippedVersion = parseGuardVersion(fs.readFileSync(path.join(srcDir, "CpuGuard.ps1"), "utf8")); } catch (e) { /* ignore */ }
  if (platform !== "win32" || testMode) return decideEnsure({ platform, testMode, flags });
  const existing = await doQuery();
  const binDir = path.join(stateDir, "bin");
  const wantArgs = buildTaskArguments({ vbs: path.join(binDir, "RunHidden.vbs"), ps1: path.join(binDir, "CpuGuard.ps1"), stateDir });
  const d = decideEnsure({ platform, testMode, flags, existing, wantArgs, shippedVersion });
  log(`cpuguard: ensure -> ${d.action} (${d.reason})`);
  if (d.action === "none") return d;
  if (d.action === "ask") {
    const yes = await askConsent();
    setFlag("cpuGuardConsent", yes ? "yes" : "no");
    if (!yes) return { action: "none", reason: "user said not now" };
  }
  if (d.action === "start") {
    return { ...d, ok: await doStart() };
  }
  const r = await doInstall({ srcDir, stateDir, log });
  if (r.ok) {
    setFlag("cpuGuardEnabled", true);
    if (r.version) setFlag("cpuGuardVersion", r.version);
  }
  log(`cpuguard: install ${r.ok ? "ok" : "FAILED: " + r.error}`);
  return { ...d, ...r };
}

async function getCpuGuardStatus({ stateDir, getFlags, platform = process.platform, srcDir }) {
  const flags = (getFlags && getFlags()) || {};
  const out = { platform, supported: platform === "win32", installed: false, running: false, taskName: null, taskState: null, enabled: flags.cpuGuardEnabled !== false, consent: flags.cpuGuardConsent || null, shippedVersion: null, status: null, hold: false, boxed: [] };
  if (srcDir) { try { out.shippedVersion = parseGuardVersion(fs.readFileSync(path.join(srcDir, "CpuGuard.ps1"), "utf8")); } catch (e) { /* ignore */ } }
  const st = readStatusFile(stateDir);
  if (st) {
    out.status = st;
    out.running = !!st.fresh;
    out.hold = !!st.hold;
    out.boxed = Array.isArray(st.boxed) ? st.boxed : st.boxed ? [st.boxed] : [];
  }
  if (platform === "win32") {
    const t = await queryTasks();
    const found = t.find((x) => x.name === TASK_NAME) || t[0];
    if (found) {
      out.installed = true;
      out.taskName = found.name;
      out.taskState = found.state;
      if (/^running$/i.test(found.state)) out.running = true;
    }
  }
  return out;
}

module.exports = {
  TASK_NAME,
  LEGACY_TASK_NAMES,
  SHIPPED_FILES,
  defaultStateDir,
  parseGuardVersion,
  buildTaskArguments,
  buildTaskXml,
  decideEnsure,
  needsReregister,
  queryTasks,
  readStatusFile,
  installGuard,
  startGuard,
  stopGuard,
  releaseGuard,
  killGuardProcesses,
  uninstallGuard,
  setTaskEnabled,
  ensureCpuGuard,
  getCpuGuardStatus,
};

// Test-mode isolation guard (v1.77.2, 2026-10-06).
//
// WHY. In test mode (AGENT_DESKTOP_TEST_MODE=1) the app used to keep several
// hardcoded real-workspace paths (ARGUS_WORKSPACE, the task store, usage_now.json,
// ~/.claude/settings.json, ...). A sandbox instance tried to write into the REAL
// "D:\Dropbox\Claude stuff\Analytics Agent\.claude-session" (Defender blocked it).
//
// WHAT. One module with three jobs:
//   1. isTestMode() / workspaceRoot() / sandboxRoot(): in test mode every
//      "workspace" root resolves under AGENT_DESKTOP_ROOT (or a private tmp dir).
//   2. assertWritable(p): throws EACCES unless p is under the sandbox root, the
//      sandbox's own userData (%APPDATA%\agent-desktop-test*), os.tmpdir(), or an
//      explicit opt-in (AGENT_DESKTOP_TEST_ALLOW_WRITE=dir1;dir2).
//   3. install(): in test mode only, wraps the fs write APIs (sync, callback and
//      promises) and child_process cwd, so a write outside the sandbox is REFUSED
//      and logged instead of performed. Outside test mode install() does nothing:
//      no function is replaced, behaviour is byte-for-byte the old behaviour.
//
// Reads are never blocked here (the harness legitimately reads some real data;
// see TEST_ISOLATION_REPORT.md for the list).
//
// A child process can still write wherever it likes (python tasks.py ...): that
// is not interceptable from here, so call sites that run real tools are gated
// separately (see flowsEnabled()).

const fs = require("fs");
const os = require("os");
const path = require("path");

const REAL_WORKSPACE = "D:\\Dropbox\\Claude stuff";

function isTestMode(env) {
  return (env || process.env).AGENT_DESKTOP_TEST_MODE === "1";
}

let privateRoot = null;
function sandboxRoot(env) {
  const e = env || process.env;
  if (e.AGENT_DESKTOP_ROOT) return path.resolve(e.AGENT_DESKTOP_ROOT);
  if (!privateRoot) privateRoot = path.join(os.tmpdir(), "agent-desktop-test-root-" + process.pid);
  return privateRoot;
}

// The "Claude stuff" workspace root. Live: the real one (unchanged). Test: sandbox.
function workspaceRoot(env) {
  return isTestMode(env) ? sandboxRoot(env) : REAL_WORKSPACE;
}

// usage_now.json: live path unchanged (relative to the app folder's grandparent).
function usageNowPath(env) {
  const e = env || process.env;
  if (!isTestMode(e)) return path.join(__dirname, "..", "..", "System Optimization & Maintenance Agent", "UsageModel", "data", "usage_now.json");
  return e.AGENT_DESKTOP_THROTTLE_FILE || path.join(sandboxRoot(e), "System Optimization & Maintenance Agent", "UsageModel", "data", "usage_now.json");
}

// Fleet-affecting flows (auto-handoff delivery, keep-going nudges, statusline /
// settings.json installs, tasks.py runs) are no-ops in test mode unless the
// fixtures explicitly opt in.
function flowsEnabled(env) {
  const e = env || process.env;
  return !isTestMode(e) || e.AGENT_DESKTOP_TEST_ENABLE_FLOWS === "1";
}

function norm(p) {
  let r = path.resolve(String(p));
  r = r.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function under(child, root) {
  const c = norm(child), r = norm(root);
  return c === r || c.startsWith(r + path.sep);
}

function allowedRoots(env) {
  const e = env || process.env;
  const roots = [sandboxRoot(e), os.tmpdir()];
  const appData = e.APPDATA || (e.USERPROFILE && path.join(e.USERPROFILE, "AppData", "Roaming"));
  if (appData) {
    // userData of the sandbox is <appData>\agent-desktop-test<suffix>; never the live "agent-desktop".
    try {
      for (const d of fs.readdirSync(appData)) if (/^agent-desktop-test/i.test(d)) roots.push(path.join(appData, d));
    } catch (err) { /* appData unreadable: fall through to the suffix entry below */ }
    roots.push(path.join(appData, "agent-desktop-test" + String(e.AGENT_DESKTOP_TEST_SUFFIX || "").replace(/[^A-Za-z0-9_-]/g, "")));
  }
  for (const x of String(e.AGENT_DESKTOP_TEST_ALLOW_WRITE || "").split(";")) if (x.trim()) roots.push(x.trim());
  return roots;
}

function isWritable(p, env) {
  if (p === undefined || p === null) return true;
  const e = env || process.env;
  if (!isTestMode(e)) return true;
  let s;
  try { s = Buffer.isBuffer(p) ? p.toString() : (p instanceof URL ? require("url").fileURLToPath(p) : String(p)); } catch (err) { return false; }
  return allowedRoots(e).some((r) => under(s, r));
}

function refusal(p) {
  const err = new Error("EACCES: test mode refuses to write outside the sandbox: " + String(p));
  err.code = "EACCES";
  err.testGuard = true;
  return err;
}

let logger = (msg) => { try { process.stderr.write("[testGuard] " + msg + "\n"); } catch (e) { /* ignore */ } };
function setLogger(fn) { if (typeof fn === "function") logger = fn; }

function assertWritable(p, env) {
  if (isWritable(p, env)) return;
  logger("REFUSED write outside sandbox: " + String(p));
  throw refusal(p);
}

// ---- install ----------------------------------------------------------------

// [name, indexes of path args that are written/removed]
const FS_PATH_FNS = [
  ["writeFile", [0]], ["appendFile", [0]], ["mkdir", [0]], ["unlink", [0]], ["rm", [0]], ["rmdir", [0]],
  ["rename", [0, 1]], ["copyFile", [1]], ["cp", [1]], ["truncate", [0]], ["utimes", [0]], ["chmod", [0]], ["chown", [0]],
  ["symlink", [1]], ["link", [1]], ["createWriteStream", [0]], ["mkdtemp", [0]],
];
const WRITE_FLAG = /[wa+]/;

function isWriteOpen(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0;
  return WRITE_FLAG.test(String(flags));
}

let installed = false;

function install(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (!isTestMode(env)) return false;
  if (installed && !o.force) return true;
  const fsMod = o.fs || fs;
  const cpMod = o.child_process || require("child_process");
  installed = true;

  const check = (p) => { assertWritable(p, env); };

  for (const [name, idxs] of FS_PATH_FNS) {
    const syncName = name + "Sync";
    const orig = fsMod[name], origSync = fsMod[syncName], origP = fsMod.promises && fsMod.promises[name];
    if (typeof origSync === "function") {
      fsMod[syncName] = function (...a) { for (const i of idxs) check(a[i]); return origSync.apply(this, a); };
    }
    if (typeof orig === "function") {
      fsMod[name] = function (...a) {
        try { for (const i of idxs) check(a[i]); } catch (err) {
          const cb = a[a.length - 1];
          if (name === "createWriteStream") throw err;
          if (typeof cb === "function") { process.nextTick(cb, err); return undefined; }
          throw err;
        }
        return orig.apply(this, a);
      };
    }
    if (typeof origP === "function") {
      fsMod.promises[name] = function (...a) {
        try { for (const i of idxs) check(a[i]); } catch (err) { return Promise.reject(err); }
        return origP.apply(this, a);
      };
    }
  }

  // open for writing (fd-based writes then need no per-call check)
  const origOpenSync = fsMod.openSync;
  fsMod.openSync = function (p, flags, ...r) { if (isWriteOpen(flags)) check(p); return origOpenSync.call(this, p, flags, ...r); };
  const origOpen = fsMod.open;
  fsMod.open = function (p, flags, ...r) {
    if (isWriteOpen(typeof flags === "function" ? undefined : flags)) {
      try { check(p); } catch (err) { const cb = r.length ? r[r.length - 1] : flags; if (typeof cb === "function") { process.nextTick(cb, err); return undefined; } throw err; }
    }
    return origOpen.call(this, p, flags, ...r);
  };
  if (fsMod.promises && fsMod.promises.open) {
    const origPOpen = fsMod.promises.open;
    fsMod.promises.open = function (p, flags, ...r) {
      if (isWriteOpen(flags)) { try { check(p); } catch (err) { return Promise.reject(err); } }
      return origPOpen.call(this, p, flags, ...r);
    };
  }

  // child processes: a cwd outside the sandbox is how sessions land in a real agent folder.
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const orig = cpMod[name];
    if (typeof orig !== "function") continue;
    cpMod[name] = function (...a) {
      for (const x of a) {
        if (x && typeof x === "object" && !Array.isArray(x) && x.cwd) {
          try { check(x.cwd); } catch (err) {
            const cb = a[a.length - 1];
            if ((name === "execFile" || name === "exec") && typeof cb === "function") { process.nextTick(cb, err, "", ""); return undefined; }
            throw err;
          }
        }
      }
      return orig.apply(this, a);
    };
  }
  logger("installed (sandbox root " + sandboxRoot(env) + ")");
  return true;
}

module.exports = {
  REAL_WORKSPACE, isTestMode, sandboxRoot, workspaceRoot, usageNowPath, flowsEnabled,
  allowedRoots, isWritable, assertWritable, install, setLogger,
};

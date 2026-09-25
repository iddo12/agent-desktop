// In-app "Update & restart" (v1.58.0). Iddo, 2026-09-25: Agent Desktop should
// notice a newer version of itself and restart onto it from inside the app,
// instead of an agent asking him to restart it by hand.
//
// Two install shapes, two sources of "newer":
//
//  - Unpackaged (`electron .` from a git checkout - Iddo's own install). Two
//    things can be newer than what is running:
//      1. the code on disk: an agent committed or pulled, but the app was not
//         restarted (app.getVersion() is read once at start, package.json on
//         disk is current);
//      2. origin/main: commits pushed that this checkout does not have yet.
//    Applying = fast-forward-only merge of origin/main (only on a clean main
//    that has no local commits of its own), then restart. It refuses rather
//    than guesses: a dirty tree, another branch, a diverged main, or a new
//    runtime dependency that is not in node_modules all stop it with the
//    reason. It never runs `npm install` itself - node-pty is a native module
//    and a rebuild from inside the running app is exactly the kind of
//    half-done state this feature must not create.
//
//  - Packaged (the installer SE is building). Newer = the latest GitHub
//    Release. For now that is a notice plus a Download button that opens the
//    release page; a silent electron-updater install needs signing and
//    publish config agreed with SE first, so it is deliberately not here yet.
//
// Git runs through the async child_process.execFile (the sync variants are
// the ones confirmed unreliable in this app's launch chain - see the
// native-agent block in main.js), and falls back to the pty runner main.js
// already uses for claude/npm if execFile cannot even start the process.
//
// Test mode never touches git and never relaunches: set
// AGENT_DESKTOP_TEST_FAKE_UPDATE=1 in the sandbox to get a fake "update
// available" and exercise the whole overlay without side effects.

const path = require("path");
const fs = require("fs");
const https = require("https");
const { execFile } = require("child_process");

const RELEASES_REPO = "iddo12/agent-desktop";
const GIT_TIMEOUT_MS = 60 * 1000;

let deps = null; // { app, runClaudeCommand, stripTerminalCodes, testMode, isVersionNewer }

function init(d) {
  deps = d;
}

function repoDir() {
  return path.join(__dirname, "..");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return null;
  }
}

function diskVersion() {
  const pkg = readJson(path.join(repoDir(), "package.json"));
  return pkg && pkg.version ? String(pkg.version) : null;
}

// ---------------------------------------------------------------- git ----

function resolveGit() {
  if (process.platform !== "win32") return "git";
  const dirs = String(process.env.PATH || "").split(";").filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d.replace(/"/g, ""), "git.exe");
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  for (const p of [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd", "git.exe"),
  ]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return null;
}

const GIT_ENV = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0", // never sit on a credential prompt
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
});

// Resolves { code, out } - code 0 on success. Never rejects.
function git(args) {
  const gitPath = resolveGit();
  if (!gitPath) return Promise.resolve({ code: -1, out: "git was not found on this computer" });
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        gitPath,
        ["--no-pager", ...args],
        { cwd: repoDir(), env: GIT_ENV(), windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err.code === "ENOENT" || err.code === "EINVAL" || err.errno === -4058)) {
            resolve(gitViaPty(gitPath, args));
            return;
          }
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, out: String(stdout || "") + (code ? String(stderr || "") : "") });
        }
      );
    } catch (e) {
      resolve(gitViaPty(gitPath, args));
      return;
    }
    if (child && child.on) child.on("error", () => {}); // handled by the callback
  });
}

// Fallback only. The pty merges stdout and stderr and has no exit code, so a
// marker line carries it: the command runs under cmd.exe with a trailing
// `echo` of the delayed-expansion errorlevel.
async function gitViaPty(gitPath, args) {
  if (!deps || !deps.runClaudeCommand) return { code: -1, out: "no command runner available" };
  const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  const quoted = ['"' + gitPath + '"', "--no-pager", ...args.map((a) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))];
  try {
    const out = await deps.runClaudeCommand(
      comspec,
      ["/d", "/v:on", "/c", quoted.join(" ") + " & echo __AD_RC=!errorlevel!"],
      { cwd: repoDir(), env: GIT_ENV(), timeoutMs: GIT_TIMEOUT_MS },
      1,
      0
    );
    const m = /__AD_RC=(\d+)/.exec(out);
    return { code: m ? Number(m[1]) : 1, out: out.replace(/__AD_RC=\d+\s*$/, "") };
  } catch (e) {
    return { code: -1, out: e.message };
  }
}

const firstLine = (s) => String(s || "").trim().split(/\r?\n/)[0].trim();

// ------------------------------------------------------------- status ----

async function unpackagedStatus({ fetch }) {
  const app = deps.app;
  const running = app.getVersion();
  const onDisk = diskVersion();
  const st = {
    mode: "git",
    running,
    onDisk,
    diskNewer: !!(onDisk && deps.isVersionNewer(onDisk, running)),
    behind: 0,
    ahead: 0,
    remoteVersion: null,
    branch: null,
    clean: null,
    canApply: false,
    blockers: [],
    commits: [],
    checkedAt: Date.now(),
    error: null,
  };

  if (!fs.existsSync(path.join(repoDir(), ".git"))) {
    st.mode = "none";
    return st;
  }

  const br = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  st.branch = br.code === 0 ? firstLine(br.out) : null;

  if (fetch) {
    const f = await git(["fetch", "--quiet", "origin", "main"]);
    if (f.code !== 0) st.error = "Could not reach GitHub: " + firstLine(f.out);
  }

  const counts = await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
  const m = /(\d+)\s+(\d+)/.exec(counts.out || "");
  if (counts.code === 0 && m) {
    st.ahead = Number(m[1]);
    st.behind = Number(m[2]);
  } else if (!st.error) {
    st.error = "Could not compare with origin/main: " + firstLine(counts.out);
  }

  if (st.behind > 0) {
    const rp = await git(["show", "origin/main:package.json"]);
    if (rp.code === 0) {
      try {
        st.remoteVersion = JSON.parse(rp.out.replace(/^\uFEFF/, "")).version || null;
      } catch (e) {}
    }
    const log = await git(["log", "--format=%s", "-n", "15", "HEAD..origin/main"]);
    if (log.code === 0) st.commits = log.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  const status = await git(["status", "--porcelain", "--untracked-files=no"]);
  st.clean = status.code === 0 && status.out.trim() === "";

  if (st.behind > 0) {
    if (st.branch !== "main") st.blockers.push(`This checkout is on "${st.branch}", not main.`);
    if (!st.clean) st.blockers.push("There are uncommitted changes in the app's folder.");
    if (st.ahead > 0) st.blockers.push(`This checkout has ${st.ahead} commit(s) that are not on GitHub, so it cannot fast-forward.`);
    const missing = await missingDependencies();
    for (const name of missing) st.blockers.push(`The new version needs "${name}", which is not installed (run npm install first).`);
    st.canApply = st.blockers.length === 0;
  }
  return st;
}

// Dependencies (and the Electron version) that origin/main's package.json
// asks for but this checkout cannot satisfy. Only `dependencies` count:
// devDependencies such as electron-builder are build-time only - except
// electron itself, whose version the app actually runs on.
async function missingDependencies() {
  const rp = await git(["show", "origin/main:package.json"]);
  if (rp.code !== 0) return ["package.json (could not read the new version's)"];
  let remote;
  try {
    remote = JSON.parse(rp.out.replace(/^\uFEFF/, ""));
  } catch (e) {
    return ["package.json (the new version's could not be parsed)"];
  }
  const local = readJson(path.join(repoDir(), "package.json")) || {};
  const out = [];
  for (const name of Object.keys(remote.dependencies || {})) {
    if (!fs.existsSync(path.join(repoDir(), "node_modules", ...name.split("/"), "package.json"))) out.push(name);
  }
  const re = (remote.devDependencies || {}).electron;
  const le = (local.devDependencies || {}).electron;
  if (re && le && re !== le) out.push("electron " + re);
  return out;
}

function packagedStatus() {
  const running = deps.app.getVersion();
  return new Promise((resolve) => {
    const base = { mode: "release", running, latest: null, url: null, updateAvailable: false, checkedAt: Date.now(), error: null };
    const req = https.get(
      `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
      { headers: { "User-Agent": "agent-desktop", Accept: "application/vnd.github+json" }, timeout: 10000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            const latest = String(j.tag_name || "").replace(/^v/i, "") || null;
            resolve({ ...base, latest, url: j.html_url || null, updateAvailable: !!(latest && deps.isVersionNewer(latest, running)) });
          } catch (e) {
            resolve({ ...base, error: "Could not read GitHub's answer" });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ ...base, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ...base, error: "GitHub did not answer in time" });
    });
  });
}

function fakeStatus() {
  const running = deps.app.getVersion();
  return {
    mode: "git",
    running,
    onDisk: running,
    diskNewer: false,
    behind: 3,
    ahead: 0,
    remoteVersion: "99.0.0",
    branch: "main",
    clean: true,
    canApply: true,
    blockers: [],
    commits: ["(test) fake commit one", "(test) fake commit two", "(test) fake commit three"],
    checkedAt: Date.now(),
    error: null,
    fake: true,
  };
}

// Normalised for the renderer: `available` + `target` + `summary` are all
// the banner needs; the rest is detail for the overlay.
async function getStatus({ fetch = true } = {}) {
  let st;
  if (deps.testMode.TEST_MODE) {
    st = process.env.AGENT_DESKTOP_TEST_FAKE_UPDATE === "1" ? fakeStatus() : { mode: "none", running: deps.app.getVersion() };
  } else if (deps.app.isPackaged) {
    st = await packagedStatus();
  } else {
    st = await unpackagedStatus({ fetch });
  }
  if (st.mode === "git") {
    st.available = st.behind > 0 || st.diskNewer;
    st.target = st.behind > 0 ? st.remoteVersion || "latest" : st.onDisk;
    st.needsPull = st.behind > 0;
    // A disk-only update needs nothing but a restart, so blockers that are
    // about pulling do not apply to it.
    st.canApply = st.behind > 0 ? st.canApply : st.diskNewer;
  } else if (st.mode === "release") {
    st.available = st.updateAvailable;
    st.target = st.latest;
    st.needsPull = false;
    st.canApply = false; // download only, for now (see top of file)
  } else {
    st.available = false;
  }
  return st;
}

// --------------------------------------------------------------- apply ----

// Pulls if needed. Returns { ok, error?, version? }. The caller restarts.
async function apply() {
  if (deps.testMode.TEST_MODE) {
    return { ok: true, version: process.env.AGENT_DESKTOP_TEST_FAKE_UPDATE === "1" ? "99.0.0" : deps.app.getVersion(), testMode: true };
  }
  if (deps.app.isPackaged) return { ok: false, error: "Installed copies update by downloading the new installer." };

  // Re-check from scratch: the overlay may have been open for a while.
  const st = await unpackagedStatus({ fetch: true });
  if (st.behind > 0) {
    if (!st.canApply) return { ok: false, error: st.blockers.join(" ") || st.error || "Cannot update right now." };
    const target = await git(["rev-parse", "origin/main"]);
    const m = await git(["merge", "--ff-only", "origin/main"]);
    const head = await git(["rev-parse", "HEAD"]);
    if (m.code !== 0 || firstLine(head.out) !== firstLine(target.out)) {
      return { ok: false, error: "The update could not be applied: " + firstLine(m.out) };
    }
  } else if (!st.diskNewer) {
    return { ok: false, error: "Agent Desktop is already up to date." };
  }
  return { ok: true, version: diskVersion() };
}

module.exports = { init, getStatus, apply, RELEASES_REPO };

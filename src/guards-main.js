// Main-process half of the "guards" feature (v1.23.0): handoff-reset support and
// usage-limit warnings. Deliberately isolated from main.js - main.js loads this
// inside try/catch, so a bug here can only disable the guards, never the app.
//
//  - guard-handoff-info      : does <agent>\handoff_latest.md exist / how fresh is it
//  - guard-archive-handoff   : copy it to <agent>\handoff_history\handoff_<stamp>.md
//                              (so the reset marker keeps showing THAT reset's lessons
//                              even after a later handoff overwrites handoff_latest.md)
//  - guard-limit-status      : real 5h / weekly % (Anthropic's own, via the statusline
//                              cache) + whether this agent's last turn was halted by a limit
//  - a 60 s poller that raises an OS notification when the 5h or weekly window crosses
//    80 / 90 / 95 % (once per threshold per window). The "limit actually hit" notification
//    already exists in main.js (notifyHalt) and is not duplicated here.
const fs = require("fs");
const path = require("path");

const THRESHOLDS = [80, 90, 95];
const POLL_MS = 60 * 1000;

function init({ ipcMain, Notification, getMainWindow, sessionCwdFor, archive, log, resolveClaudeExecutable }) {
  const say = typeof log === "function" ? log : () => {};

  // 2026-09-20 follow-up: the auth-broken banner used to just print
  // `claude auth login` as text - which then fails from a plain PowerShell
  // window on this machine (claude.cmd is a symlink Windows can't always
  // resolve, see memory claude-cmd-symlink-flakiness), forcing Iddo to hunt
  // down the real claude.exe path by hand every time. This button reuses
  // main.js's own resolveClaudeExecutable() (the same lookup that already
  // handles that symlink) and opens a normal, visible console window running
  // it - not a fully hidden spawn - since the login flow's own behavior
  // (does it need a keypress after the browser step completes?) isn't
  // something to gamble on hiding from view.
  ipcMain.handle("guard-trigger-login", () => {
    try {
      const claudeExe = typeof resolveClaudeExecutable === "function" ? resolveClaudeExecutable() : "claude";
      const child = require("child_process").spawn("cmd.exe", ["/c", "start", '""', `"${claudeExe}"`, "auth", "login"], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      });
      child.unref();
      say(`guard-trigger-login: launched ${claudeExe} auth login in a new console window`);
      return { ok: true };
    } catch (e) {
      say(`guard-trigger-login failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("guard-handoff-info", (event, { agentPath }) => {
    try {
      const p = path.join(agentPath, "handoff_latest.md");
      const st = fs.statSync(p);
      return { exists: true, path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size };
    } catch (e) {
      return { exists: false };
    }
  });

  ipcMain.handle("guard-archive-handoff", (event, { agentPath }) => {
    try {
      const src = path.join(agentPath, "handoff_latest.md");
      const text = fs.readFileSync(src, "utf-8");
      const dir = path.join(agentPath, "handoff_history");
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const dest = path.join(dir, `handoff_${stamp}.md`);
      fs.writeFileSync(dest, text, "utf-8");
      return { ok: true, path: dest, lessons: archive.extractLessons(text) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Did `needle` reach this agent's NEWEST transcript (tail only)? Used to verify that a message
  // typed into the pty was really received by the CLI - 2026-09-19: after /clear on a large
  // session the CLI silently ignored everything typed, and the app had no way to notice.
  ipcMain.handle("guard-transcript-has", (event, { agentPath, needle }) => {
    try {
      if (!agentPath || !needle) return false;
      const dir = path.join(require("os").homedir(), ".claude", "projects", archive.encodeProjectPath(sessionCwdFor(agentPath)));
      let newest = null;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { full, mtimeMs: st.mtimeMs, size: st.size };
      }
      if (!newest) return false;
      const len = Math.min(newest.size, 256 * 1024);
      const fd = fs.openSync(newest.full, "r");
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, newest.size - len);
        return buf.toString("utf-8").includes(needle);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      return false;
    }
  });

  // 2026-09-20 incident: the shared ~/.claude/.credentials.json OAuth login
  // silently expired overnight (the CLI's own background daemon logged
  // "proactive refresh failed, signalling re-auth required" then just quietly
  // polled the keychain instead of surfacing anything). Every agent then
  // failed EVERY turn instantly with authentication_failed, which the old
  // code lumped in with "usage limit reached" - actively misleading, since
  // the real fix (re-login) is nothing like waiting out a rate limit.
  // Checked here (not just per-agent halt detection) so the banner shows on
  // ANY agent tab even one that hasn't tried and failed yet itself.
  function isAuthBroken() {
    try {
      const raw = fs.readFileSync(path.join(require("os").homedir(), ".claude", ".credentials.json"), "utf-8");
      const oauth = JSON.parse(raw).claudeAiOauth;
      return !oauth || !oauth.accessToken || !oauth.refreshToken;
    } catch (e) {
      return false; // file missing/unreadable isn't this signature - don't false-alarm
    }
  }

  ipcMain.handle("guard-limit-status", (event, { agentPath }) => {
    const out = { halt: null, fiveHour: null, sevenDay: null, authBroken: false };
    try {
      const c = archive.getConfirmedRateLimits();
      out.fiveHour = c.fiveHour;
      out.sevenDay = c.sevenDay;
    } catch (e) {}
    try {
      out.authBroken = isAuthBroken();
    } catch (e) {}
    try {
      if (agentPath) out.halt = archive.getHaltInfo(sessionCwdFor(agentPath));
    } catch (e) {}
    return out;
  });

  const notified = new Set(); // "<window>|<resetsAt>|<threshold>"
  function pollLimits() {
    let c;
    try {
      c = archive.getConfirmedRateLimits();
    } catch (e) {
      return;
    }
    for (const [key, label] of [["fiveHour", "5-hour"], ["sevenDay", "weekly"]]) {
      const w = c[key];
      if (!w || typeof w.usedPct !== "number") continue;
      // highest threshold crossed; only announce it once per window
      const crossed = THRESHOLDS.filter((t) => w.usedPct >= t).pop();
      if (!crossed) continue;
      const id = `${key}|${w.resetsAt}|${crossed}`;
      if (notified.has(id)) continue;
      THRESHOLDS.filter((t) => t <= crossed).forEach((t) => notified.add(`${key}|${w.resetsAt}|${t}`));
      const when = w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "unknown";
      try {
        if (Notification.isSupported()) {
          const n = new Notification({
            title: `Claude ${label} usage at ${Math.round(w.usedPct)}%`,
            body: `Resets ${when}. Agents will stop at 100% - consider pausing heavy work.`,
          });
          n.on("click", () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
            }
          });
          n.show();
        }
        say(`limit warning: ${label} ${Math.round(w.usedPct)}% (threshold ${crossed})`);
      } catch (e) {}
    }
  }
  const timer = setInterval(pollLimits, POLL_MS);
  if (timer.unref) timer.unref();
  setTimeout(pollLimits, 5000);
}

module.exports = { init };

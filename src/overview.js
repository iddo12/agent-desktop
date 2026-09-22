// Data behind the header's Tasks panel and the sidebar's session-state rings
// (v1.37.0). Both were sandbox-only demos on sample data until this file
// existed - they graduated to the live app only once they could show real
// state, because a panel that shows invented tasks is worse than no panel.
//
// Three sources, all read-only except approveTelegramTasks():
//   1. Session state per agent - working / ready / idle - from the same
//      getSessionActivity() that drives "Working... 13s", plus the claude
//      daemon's own pid file for "is a process alive at all".
//   2. Each agent's own "OPEN NOW" list (root CLAUDE.md standing order
//      2026-09-18). Agents write it freehand, so the parser is tolerant:
//      numbered items, bullets under ### sub-headings, and a bold
//      "**OPEN NOW ...**" line inside a Status block are all seen live.
//   3. The Telegram task queue (Security\Tools\TelegramBridge\tasks.py), one
//      JSON file per task. Approval goes THROUGH tasks.py rather than
//      rewriting the JSON here, so the per-agent telegram_tasks.md files and
//      the history trail stay exactly as the CLI would leave them. The
//      approval gate is that bridge's security model - Iddo clicking Approve
//      is the gate working, never something to automate.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { getSessionActivity, getLatestUsage, getHaltInfo, newestTranscript } = require("./archive");

const TELEGRAM_TASKS_DIR = "E:\\Claude work\\Security\\TelegramBridge\\tasks";
const UNASSIGNED = "(unassigned)";
const OPEN_ITEM_FILES = ["Active_Tasks.md", "master_state.md"];
const CONTEXT_ATTENTION_TOKENS = 150000; // same line as guards.js's warning banner
const LONG_TURN_MS = 30 * 60 * 1000;
const MAX_ITEM_CHARS = 110;

function daemonAlive(sessionCwd) {
  const newest = newestTranscript(sessionCwd);
  if (!newest) return false;
  const short = path.basename(newest.jsonlPath, ".jsonl").split("-")[0];
  const pidFile = path.join(os.homedir(), ".claude", "daemon", "pty-pids", `${short}.pid`);
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// One line per item: the bold lead-in when the item has one (that is how
// every agent here titles its items), otherwise the first sentence.
function shortLine(raw) {
  let s = raw.replace(/^\s*(\d+[.)]|[-*])\s+/, "").trim();
  s = s.replace(/^(\*\*)?\s*(TO DO|TODO)\s*:\s*/i, "$1");
  const bold = s.match(/^\*\*(.+?)\*\*/);
  // A bold lead-in of a word or two ("Decide:") is a label, not a title -
  // keep the sentence it introduces.
  if (bold && bold[1].replace(/[.:\s]+$/, "").length >= 18) s = bold[1];
  else s = s.replace(/\*\*/g, "").split(/(?<=[.!?])\s/)[0];
  s = s.replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[.:\s]+$/, "").trim();
  // Prefer the first clause when the whole sentence is long.
  if (s.length > 70) {
    const cut = s.search(/ \(| - | -- |; /);
    if (cut >= 25) s = s.slice(0, cut);
  }
  return s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS - 1) + "…" : s;
}

// Parses the FIRST "OPEN NOW" section - agents keep older dated ones below
// it for history, and those are superseded by definition.
function parseOpenNow(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*(#{1,4}\s+|\*\*)\s*OPEN NOW\b/i.test(l));
  if (start < 0) return null;
  // A heading-started section runs to the next heading of the same level; a
  // bold-line one (sitting inside some other section) ends at its first
  // blank line once items have begun, since it has no heading to close it.
  const hm = lines[start].match(/^\s*(#+)\s/);
  const headingLevel = hm ? hm[1].length : 0;
  const items = [];
  let seenItem = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^(#+)\s/);
    if (h && (!headingLevel || h[1].length <= headingLevel)) break;
    if (!headingLevel && seenItem && !l.trim()) break;
    if (/^\s*#+\s.*OPEN NOW/i.test(l)) break;
    // Top-level items only: continuation lines and nested sub-bullets are
    // detail, not separate tasks.
    if (!/^ {0,1}(\d+[.)]|[-*])\s+\S/.test(l)) continue;
    const body = l.replace(/^\s*(\d+[.)]|[-*])\s+/, "");
    if (/^(\*\*)?\s*(DONE|FIXED|CLOSED)\b/i.test(body)) continue;
    if (/^(\*\*)?\s*Nothing outstanding/i.test(body)) continue;
    seenItem = true;
    const line = shortLine(l);
    if (line) items.push(line);
  }
  return items;
}

function readOpenItems(agentPath) {
  for (const name of OPEN_ITEM_FILES) {
    const p = path.join(agentPath, name);
    try {
      const items = parseOpenNow(fs.readFileSync(p, "utf-8"));
      if (items) return { file: name, items };
    } catch (e) {
      /* missing or unreadable - try the next candidate */
    }
  }
  return { file: null, items: [] };
}

function readTelegramTasks() {
  let files;
  try {
    files = fs.readdirSync(TELEGRAM_TASKS_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch (e) {
    return []; // no queue yet - the bridge has never received a message
  }
  const out = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TELEGRAM_TASKS_DIR, f), "utf-8"));
      if (t && (t.status === "pending" || t.status === "approved")) {
        out.push({ id: t.id, body: t.body, agent: t.agent, status: t.status, createdAt: t.createdAt });
      }
    } catch (e) {
      /* half-written file - it will be complete on the next poll */
    }
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function getAgentOverview(agents, sessionCwdFor) {
  const telegram = readTelegramTasks();
  const now = Date.now();
  const result = agents.map((a) => {
    const cwd = sessionCwdFor(a.path);
    let activity = { working: false, sinceMs: 0 };
    try { activity = getSessionActivity(cwd); } catch (e) { /* treat as not working */ }
    const alive = activity.working || daemonAlive(cwd);
    const state = activity.working ? "working" : alive ? "ready" : "idle";

    const attention = [];
    if (a.paused) attention.push("paused");
    try {
      const halt = getHaltInfo(cwd);
      if (halt && !activity.working) {
        const mins = halt.timestamp ? Math.round((now - new Date(halt.timestamp).getTime()) / 60000) : null;
        attention.push(`halted on ${halt.kind.replace(/_/g, " ")}${mins != null ? ` ${mins} min ago` : ""}`);
      }
    } catch (e) { /* no halt info */ }
    // Context is returned raw rather than folded into `attention`: only the
    // renderer knows whether that reading predates a handoff reset
    // (window.guardUsageIsStale), and a stale 500K would be a false alarm.
    let context = null;
    try {
      const usage = getLatestUsage(cwd);
      if (usage && usage.contextTokens >= CONTEXT_ATTENTION_TOKENS) context = usage;
    } catch (e) { /* no usage yet */ }
    if (activity.working && activity.sinceMs > LONG_TURN_MS) {
      attention.push(`working for ${Math.round(activity.sinceMs / 60000)} min - check it is not stuck`);
    }

    const open = readOpenItems(a.path);
    return {
      path: a.path,
      folderName: a.folderName,
      displayName: a.displayName,
      state,
      sinceMs: activity.sinceMs,
      attention,
      context,
      openFile: open.file,
      openItems: open.items,
      telegram: telegram.filter((t) => t.agent === a.folderName),
    };
  });
  return { agents: result, unassigned: telegram.filter((t) => t.agent === UNASSIGNED && t.status === "pending") };
}

// Only ever called from a click on the panel's Approve buttons.
function approveTelegramTasks(ids, telegramDir) {
  const clean = (ids || []).filter((id) => /^[0-9]{6}-[0-9a-f]{4}$/.test(id));
  if (!clean.length) return Promise.resolve({ ok: false, output: "no valid task ids" });
  return new Promise((resolve) => {
    execFile("python", [path.join(telegramDir, "tasks.py"), "--approve", ...clean],
      { cwd: telegramDir, windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => resolve({ ok: !err, output: String(stdout || "") + String(stderr || "") }));
  });
}

module.exports = { getAgentOverview, approveTelegramTasks, parseOpenNow };

// Turns Claude Code's own structured JSONL session transcripts into clean,
// human-readable, dated markdown files saved locally in each agent's own
// folder - not relying on Claude Code's internal session storage for
// long-term readability, and not the raw ANSI-laden terminal log (which is
// what this replaces - see agent-desktop\CLAUDE.md for why).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { withFsRetry } = require("./fsRetry");

// Diagnosed 2026-08-22, the real root cause behind a whole day of "the
// Chat View just shows nothing" reports for one specific agent (LensVid
// Business Context, folder name "LensVid_Master_Context"): Claude Code
// CLI's own project-directory encoding also turns underscores into
// hyphens, not just colons/backslashes/spaces/dots - confirmed directly
// by listing the real ~/.claude/projects folder, where this agent's
// actual directory is "...LensVid-Master-Context--claude-session" (dashes
// throughout) while this function was producing "...LensVid_Master_Context--
// claude-session" (underscores preserved) for the exact same cwd. Every
// other agent folder in this workspace happens to have no underscore in
// its name, which is why this sat unnoticed - findJsonlFiles() was quietly
// scanning a directory that never existed, always returning zero files,
// for this one agent only.
function encodeProjectPath(cwd) {
  return cwd.replace(/[:\\/ ._]/g, "-");
}

function projectDirFor(cwd) {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectPath(cwd));
}

function findJsonlFiles(sessionCwd) {
  const dir = projectDirFor(sessionCwd);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch (e) {
    return [];
  }
}

// Assistant message content can be a plain string or an array of content
// blocks (text / tool_use / tool_result / etc.) - only text is kept for a
// readable transcript; tool calls are noted briefly rather than dumped raw.
function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) {
      parts.push(block.text.trim());
    } else if (block.type === "tool_use" && block.name) {
      parts.push(`_[used tool: ${block.name}]_`);
    }
  }
  return parts.join("\n\n").trim();
}

function parseTranscriptEntries(jsonlPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, "utf-8");
  } catch (e) {
    return [];
  }

  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (!obj.message || !obj.timestamp) continue;
    const text = extractText(obj.message.content);
    if (!text) continue;
    entries.push({ timestamp: obj.timestamp, role: obj.type, text });
  }
  return entries;
}

// The Chat View used to render live by scraping xterm.js's own terminal
// buffer (see agent-desktop\CLAUDE.md, "Chat View went completely blank
// mid-conversation" for the incident that forced this rethink) - fragile by
// nature, since it's re-derived from whatever the terminal currently shows
// rather than any persistent record, and a bad read (a mid-redraw sample, an
// alternate screen buffer, a bounded scrollback on a long session) could
// wipe a real, already-shown conversation. This is the replacement data
// source: read directly from Claude Code's own JSONL transcript, the exact
// same file History already reads reliably, instead of the terminal.
//
// Originally avoided for the live view specifically because JSONL entries
// were assumed to only get written once a turn fully completes, which would
// have lost the "watching it respond live" feel raw terminal output has.
// That assumption turned out to be wrong - confirmed directly (2026-08-19)
// by inspecting a real session's JSONL while a multi-step answer was being
// generated: every distinct content block (a thinking segment, a text
// segment, each individual tool call) gets appended as its own JSONL line
// as soon as that block finishes, with real sub-second-to-low-single-digit-
// second gaps between them matching genuine generation timing - not one
// giant write at the very end. So this can genuinely tail live, just at
// block granularity (a whole tool call, a whole finished text segment)
// rather than token-by-token like the raw terminal shows - a real trade
// worth making, especially now that the live "thinking" seconds counter
// (see CLAUDE.md, same day) already covers the "is anything happening at
// all" gap this would otherwise leave during a long tool-heavy stretch with
// no new text block yet.
//
// Produces the same {role, lines} block shape classifyTerminalLines() used
// to produce (renderer.js), specifically so renderChatBlocks() - including
// the [[DETAILS]]/[[WARNING]]/[[KEY]] marker-splitting, which only cares
// about a role and its text, not where the text came from - needed zero
// changes to consume this instead. Deliberately simpler than
// parseTranscriptEntries() below (History's own reader): no need to
// dedupe/group by date, no markdown-italic tool-call wrapping (this is
// plain text, not a saved .md file), and thinking blocks are skipped
// entirely, same as parseTranscriptEntries() already does - not meant for
// display, consistent with how the terminal UI itself never showed them.
// Caught live (2026-08-20): `/clear` doesn't append a "cleared" marker to
// the same file - it starts an entirely new JSONL file with its own fresh
// session ID, leaving the old one (with the full pre-clear conversation)
// sitting untouched on disk. findJsonlFiles() returns every file for this
// cwd, which is exactly right for getLatestUsage() below (it just wants
// whichever single entry has the latest timestamp, so old files are
// harmless noise it naturally ignores) and for History (which deliberately
// wants the full historical record across every past session). It's wrong
// here: merging every file's entries together for the live Chat View meant
// Reset Session appeared to do nothing - the "cleared" conversation still
// showed the entire old one glued in front of it, confirmed directly (a
// tiny ~2KB fresh file sitting next to a 4.8MB historical one, both for the
// same agent). Fixed by scoping to only the single file that's actually
// being written to right now - found by comparing each file's own latest
// entry timestamp (not filesystem mtime, which can be touched by things
// unrelated to real writes) and keeping only that one file's entries.
function getLiveTranscriptBlocks(sessionCwd) {
  let currentFileEntries = [];
  let currentFileLatestTs = -Infinity;
  for (const jsonlPath of findJsonlFiles(sessionCwd)) {
    let raw;
    try {
      raw = fs.readFileSync(jsonlPath, "utf-8");
    } catch (e) {
      continue;
    }
    const fileEntries = [];
    let fileLatestTs = -Infinity;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (!obj.timestamp) continue;
      fileEntries.push(obj);
      const ts = new Date(obj.timestamp).getTime();
      if (ts > fileLatestTs) fileLatestTs = ts;
    }
    if (fileLatestTs > currentFileLatestTs) {
      currentFileLatestTs = fileLatestTs;
      currentFileEntries = fileEntries;
    }
  }
  const entries = currentFileEntries;
  entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const blocks = [];
  for (const obj of entries) {
    if (obj.type === "user" && obj.origin && obj.origin.kind === "human") {
      // Mirrors the same human-vs-tool-result "user" entry filter already
      // proven correct in getUsageWindows() below - a tool_result is also
      // type:"user" in this format but isn't a real message from the user.
      const text = extractText(obj.message && obj.message.content);
      if (text) blocks.push({ role: "user", lines: [text], timestamp: obj.timestamp });
    } else if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
      // Caught live (2026-08-19): a `model:"<synthetic>"` entry is Claude
      // Code's own internal harness bookkeeping (seen once with the literal
      // text "No response requested.") - not a real generated reply, and
      // was rendering as if it were one. Skip these entirely.
      if (obj.message.model === "<synthetic>") continue;
      for (const block of obj.message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && block.text && block.text.trim()) {
          blocks.push({ role: "agent", lines: [block.text.trim()], timestamp: obj.timestamp });
        } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          // Caught live the same day: this tool doesn't actually pause for
          // real interactive input in Agent Desktop's non-interactive pty -
          // it auto-resolves itself with a guessed answer a beat later (see
          // the tool_result branch below) without ever showing the user what it
          // asked. Rendering just "[used tool: AskUserQuestion]" left the
          // entire question invisible - he'd see the tool ran, never see
          // what it was actually asking. Surface the real question text
          // instead, one status line per question in the call.
          const questions = (block.input && block.input.questions) || [];
          for (const q of questions) {
            if (q && q.question) blocks.push({ role: "status", lines: [`[asked: "${q.question}"]`], timestamp: obj.timestamp });
          }
        } else if (block.type === "tool_use" && block.name) {
          blocks.push({ role: "status", lines: [`[used tool: ${block.name}]`], timestamp: obj.timestamp });
        }
      }
    } else if (obj.type === "user" && Array.isArray(obj.message && obj.message.content)) {
      // A tool_result for the AskUserQuestion case above specifically -
      // shows what it auto-answered, since that resolution happens
      // invisibly (see the tool_use branch above) and the user has no other way
      // to see what was actually decided on his behalf.
      for (const block of obj.message.content) {
        if (block && block.type === "tool_result" && typeof block.content === "string" && /^Your questions have been answered/.test(block.content)) {
          blocks.push({ role: "status", lines: [`[${block.content}]`], timestamp: obj.timestamp });
        }
      }
    }
  }
  return blocks;
}

// Each assistant JSONL entry already carries structured token usage for
// that turn - reused here for the live context/token indicator rather than
// anything the CLI displays on its own (it doesn't, in the terminal UI).
// "Context tokens" approximates what's currently sent to the model each
// turn: cache_read + cache_creation + input (excludes output_tokens, which
// only becomes part of context on the *next* turn once it's been read back
// in). Scans every JSONL file for this cwd (there can be more than one from
// past sessions before this project's own --continue encoding bug was
// fixed) and keeps whichever entry has the latest timestamp. Deliberately
// scoped to just this one agent's sessionCwd - context size genuinely IS
// per-conversation, unlike the token-buffer figure that used to live here
// too (moved to getUsageWindows() below, since that's an account-wide
// throttle, not something a single conversation's own files can fully see -
// see the comment there for the full story of that correction).
function getLatestUsage(sessionCwd) {
  let latestUsage = null;

  for (const jsonlPath of findJsonlFiles(sessionCwd)) {
    let raw;
    try {
      raw = fs.readFileSync(jsonlPath, "utf-8");
    } catch (e) {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (!obj.timestamp) continue;
      if (obj.type !== "assistant" || !obj.message || !obj.message.usage) continue;
      if (!latestUsage || new Date(obj.timestamp) > new Date(latestUsage.timestamp)) {
        const u = obj.message.usage;
        latestUsage = {
          timestamp: obj.timestamp,
          contextTokens: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0),
          outputTokens: u.output_tokens || 0,
        };
      }
    }
  }

  return latestUsage;
}

function dateKeyFromTimestamp(ts) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

function groupByDate(entries) {
  const byDate = new Map();
  for (const entry of entries) {
    const key = dateKeyFromTimestamp(entry.timestamp);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(entry);
  }
  return byDate;
}

function formatDayMarkdown(dateKey, entries) {
  const lines = [`# ${dateKey}`, ""];
  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const who = entry.role === "user" ? "You" : "Agent";
    lines.push(`### ${time} â€” ${who}`, "", entry.text, "");
  }
  return lines.join("\n");
}

function dayFilePath(agentPath, dateKey) {
  const [year, month, day] = dateKey.split("-");
  const dir = path.join(agentPath, "sessions", year, month);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${day}.md`);
}

// Regenerates each affected day's file fully from the JSONL source of truth,
// rather than appending incrementally - JSONL is authoritative, so this is
// both simpler and avoids any risk of duplicate entries from re-syncing.
function syncArchive(agentPath, sessionCwd) {
  const jsonlFiles = findJsonlFiles(sessionCwd);
  const allEntries = jsonlFiles.flatMap(parseTranscriptEntries);
  if (allEntries.length === 0) return { daysWritten: 0 };

  const byDate = groupByDate(allEntries);
  for (const [dateKey, entries] of byDate) {
    entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const md = formatDayMarkdown(dateKey, entries);
    withFsRetry(() => fs.writeFileSync(dayFilePath(agentPath, dateKey), md, "utf-8"));
  }
  return { daysWritten: byDate.size };
}

function listArchivedDays(agentPath) {
  const sessionsRoot = path.join(agentPath, "sessions");
  const days = [];
  try {
    for (const year of fs.readdirSync(sessionsRoot)) {
      const yearDir = path.join(sessionsRoot, year);
      if (!fs.statSync(yearDir).isDirectory()) continue;
      for (const month of fs.readdirSync(yearDir)) {
        const monthDir = path.join(yearDir, month);
        if (!fs.statSync(monthDir).isDirectory()) continue;
        for (const file of fs.readdirSync(monthDir)) {
          if (!file.endsWith(".md")) continue;
          const day = file.replace(/\.md$/, "");
          days.push(`${year}-${month}-${day}`);
        }
      }
    }
  } catch (e) {
    /* no archive yet */
  }
  return days.sort().reverse(); // newest first
}

function readArchivedDay(agentPath, dateKey) {
  try {
    return fs.readFileSync(dayFilePath(agentPath, dateKey), "utf-8");
  } catch (e) {
    return null;
  }
}

// Claude's real rate limits (a rolling 5-hour message window, and a weekly
// cap measured in "active compute hours") are account-wide, not tied to any
// one conversation or even to Agent Desktop specifically - usage anywhere
// (any Claude Code session on this machine, claude.ai, Cowork) draws from
// the same pool. Anthropic doesn't expose either figure through any API
// this app can read, so this scans EVERY project bucket under
// ~/.claude/projects/ (not just agents this app manages) for genuine human-
// typed prompt counts (type:"user" entries with origin.kind === "human" -
// this excludes tool-result "user" entries and synthetic --continue
// markers like isMeta:true "Continue from where you left off", neither of
// which count as an actual message sent) within two windows: the trailing
// 5 hours and the trailing 7 days.
//
// First version of the weekly figure summed `turn_duration.durationMs` as
// a proxy for "active compute hours" - found and discarded the same day:
// direct inspection showed only 23 such entries exist across the ENTIRE
// account, nowhere near the real number of turns that actually happened,
// meaning Claude Code doesn't log that marker for every turn. That made it
// a significant undercount, not a rough-but-fair estimate, so it's gone.
// Message counting (proven reliable for the 5h window already) is reused
// for the 7-day window instead - real and comprehensive, even though the
// unit (messages) doesn't match what Anthropic's real weekly cap actually
// measures (compute-hours). Deliberately NOT converted into a fake
// percentage against a compute-hours limit - a percentage built by
// dividing two different units together would be a second layer of
// fabrication on top of the first. The raw count is shown instead.
//
// The token-buffer figure (see getLatestUsage() above for what it is and
// why it's framed as a short-term throttle, not a plan budget) also lives
// here now, not there - moved the same day the user asked "this buffer, is
// that the specific agent's buffer?" and the honest answer was "yes, and
// it shouldn't be." The underlying throttle is realistically account-wide
// (Claude's rate limiting operates per account/API key, not per
// conversation), so scoping it to one agent's own JSONL files could only
// ever see a partial picture - bursts from other agents or other sessions
// on this machine wouldn't register. Tracked in the same account-wide scan
// as the message counts, for the same reason.
// Real, Anthropic-reported rate-limit usage, read from the cache file
// src/statusline.cjs writes every time ANY interactive `claude` session on
// this machine (this app's own, or a terminal Iddo opens himself) receives
// an API response - see that file's own comment for why this is
// account-wide by design, and CLAUDE.md's "Real design flaw found and fixed"
// section for why the message-count heuristic below has to stay account-wide
// too. Returns nulls if the statusLine was never installed, has never fired
// yet (e.g. right after a fresh install, before any session has completed a
// turn), or - deliberately - if the window it describes has already reset
// (`resets_at` in the past), since a stale figure from an expired window is
// actively misleading, not just imprecise.
function getConfirmedRateLimits() {
  const cachePath = path.join(os.homedir(), ".claude", "agent-desktop-rate-limits.json");
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch (e) {
    return { fiveHour: null, sevenDay: null };
  }
  const nowSec = Date.now() / 1000;
  // How long ago statusline.cjs last wrote this cache - surfaced so the UI
  // can show real freshness instead of implying a live figure. Found to
  // matter directly, 2026-08-23: Iddo saw a 69% badge at the same moment
  // Claude's own native app was already showing "approaching weekly
  // limit" - not a wrong number, a ~20-minute-stale one (the cache only
  // updated on real interactive turns before RATE_LIMIT_REFRESH_INTERVAL_
  // SECONDS was added in main.js). That refresh interval now bounds the
  // worst case going forward, but showing the age directly means Iddo
  // never has to just trust it.
  const ageSeconds = cache.updatedAt ? Math.max(0, Math.round(nowSec - new Date(cache.updatedAt).getTime() / 1000)) : null;
  const fiveHour =
    typeof cache.fiveHourUsedPct === "number" && !(cache.fiveHourResetsAt && cache.fiveHourResetsAt < nowSec)
      ? { usedPct: cache.fiveHourUsedPct, resetsAt: cache.fiveHourResetsAt || null, ageSeconds }
      : null;
  const sevenDay =
    typeof cache.sevenDayUsedPct === "number" && !(cache.sevenDayResetsAt && cache.sevenDayResetsAt < nowSec)
      ? { usedPct: cache.sevenDayUsedPct, resetsAt: cache.sevenDayResetsAt || null, ageSeconds }
      : null;
  return { fiveHour, sevenDay };
}

function getUsageWindows() {
  const now = Date.now();
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  let messagesInLast5h = 0;
  let messagesInLast7d = 0;
  let latestPlanTokens = null;
  let maxPlanTokensSeen = 0;
  // Per-calendar-day message counts, for the "this month" view Iddo asked
  // for on top of the 5h/7d windows above. Built in the same scan pass
  // (not a separate re-scan of every JSONL file in the account) purely for
  // efficiency - this account-wide scan already reads every line once.
  const dailyMessageCounts = new Map(); // "YYYY-MM-DD" (local time) -> count
  let earliestTimestampMs = null;

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (e) {
    return {
      messagesInLast5h: 0,
      messagesInLast7d: 0,
      planTokenBufferPct: null,
      fiveHourConfirmed: null,
      sevenDayConfirmed: null,
      monthly: buildMonthlyUsage(new Map(), null, Date.now()),
    };
  }

  for (const projectDir of projectDirs) {
    const dirPath = path.join(projectsRoot, projectDir.name);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch (e) {
      continue;
    }
    for (const file of files) {
      let raw;
      try {
        raw = fs.readFileSync(path.join(dirPath, file), "utf-8");
      } catch (e) {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (!obj.timestamp) continue;

        if (obj.type === "user" && obj.origin && obj.origin.kind === "human") {
          const t = new Date(obj.timestamp).getTime();
          if (!Number.isNaN(t)) {
            if (now - t <= SEVEN_DAYS_MS) {
              messagesInLast7d++;
              if (now - t <= FIVE_HOURS_MS) messagesInLast5h++;
            }
            if (earliestTimestampMs === null || t < earliestTimestampMs) earliestTimestampMs = t;
            const d = new Date(t);
            const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            dailyMessageCounts.set(dayKey, (dailyMessageCounts.get(dayKey) || 0) + 1);
          }
        }

        if (obj.type === "attachment" && obj.attachment && obj.attachment.type === "total_tokens_reminder") {
          const match = /total_tokens>\s*([\d,]+)/.exec(obj.attachment.text || "");
          if (match) {
            const value = parseInt(match[1].replace(/,/g, ""), 10);
            if (value > maxPlanTokensSeen) maxPlanTokensSeen = value;
            if (!latestPlanTokens || new Date(obj.timestamp) > new Date(latestPlanTokens.timestamp)) {
              latestPlanTokens = { timestamp: obj.timestamp, remaining: value };
            }
          }
        }
      }
    }
  }

  const confirmed = getConfirmedRateLimits();

  return {
    messagesInLast5h,
    messagesInLast7d,
    planTokenBufferPct:
      latestPlanTokens && maxPlanTokensSeen > 0
        ? Math.round((latestPlanTokens.remaining / maxPlanTokensSeen) * 100)
        : null,
    planTokenBufferRemaining: latestPlanTokens ? latestPlanTokens.remaining : null,
    planTokenBufferCeiling: maxPlanTokensSeen || null,
    // Real Anthropic-reported figures when available (see
    // getConfirmedRateLimits() above) - renderer.js prefers these over the
    // messagesInLast5h/7d heuristic whenever present, since they're an
    // actual reported percentage rather than an estimate against a
    // community-sourced message-count guess.
    fiveHourConfirmed: confirmed.fiveHour,
    sevenDayConfirmed: confirmed.sevenDay,
    monthly: buildMonthlyUsage(dailyMessageCounts, earliestTimestampMs, now, confirmed.sevenDay, messagesInLast7d),
  };
}

// Real numbers (messages/pace/projection) plus one labeled ESTIMATED
// percentage - researched first, not guessed: checked the most
// sophisticated community tool in this space (Claude Code Usage Monitor /
// claude-monitor, the one with ML burn-rate predictions) directly against
// its own docs, and confirmed even it explicitly scopes itself to the 5h/
// weekly windows only and states monthly percentages aren't calculated,
// "because there's no monthly limit in Claude Code's architecture to
// calculate one against." Same story with ccusage - its "monthly" view is
// raw token/cost totals, never a percentage. Nobody has solved this
// because Anthropic doesn't publish a monthly cap to solve it against - so
// estimatedMonthlyCapacityPct below is exactly that, an estimate, built by
// extrapolating the one real number that DOES exist (the confirmed 7-day
// percentage) across a month's worth of weeks, not a claim about a real
// limit. Iddo explicitly asked for this after being shown the research and
// the alternative (wait for real month-over-month comparison data) -
// chose "build the best available estimate now."
function buildMonthlyUsage(dailyMessageCounts, earliestTimestampMs, now, sevenDayConfirmed, messagesInLast7d) {
  const nowDate = new Date(now);
  const year = nowDate.getFullYear();
  const month = nowDate.getMonth(); // 0-indexed
  const dayOfMonth = nowDate.getDate(); // 1-indexed - also "days elapsed so far," today included
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dayKey = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  let messagesThisMonth = 0;
  for (let day = 1; day <= dayOfMonth; day++) {
    messagesThisMonth += dailyMessageCounts.get(dayKey(year, month, day)) || 0;
  }

  const prevMonthDate = new Date(year, month - 1, 1);
  const prevYear = prevMonthDate.getFullYear();
  const prevMonth = prevMonthDate.getMonth();
  const daysInPrevMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
  const dataGoesBackToPrevMonth = earliestTimestampMs !== null && earliestTimestampMs <= new Date(prevYear, prevMonth, 1).getTime();

  let messagesLastMonth = null;
  if (dataGoesBackToPrevMonth) {
    messagesLastMonth = 0;
    for (let day = 1; day <= daysInPrevMonth; day++) {
      messagesLastMonth += dailyMessageCounts.get(dayKey(prevYear, prevMonth, day)) || 0;
    }
  }

  // Derive an implied "messages per 100% of the weekly cap" from the one
  // real data point available (the confirmed 7-day percentage and the real
  // message count behind it), then scale by weeks-per-month to get an
  // implied monthly-equivalent capacity - anchored to Anthropic's own real
  // figure rather than invented outright, but still fundamentally an
  // extrapolation, not a fact. Guarded against sevenDayUsedPct being 0
  // (division by zero) and against a missing confirmed figure entirely
  // (falls back to null - no estimate shown rather than a wrong one).
  let estimatedMonthlyCapacityPct = null;
  if (sevenDayConfirmed && sevenDayConfirmed.usedPct > 0 && messagesInLast7d > 0) {
    const impliedMessagesPerFullWeek = messagesInLast7d / (sevenDayConfirmed.usedPct / 100);
    const WEEKS_PER_MONTH = daysInMonth / 7;
    const impliedMonthlyCapacityMessages = impliedMessagesPerFullWeek * WEEKS_PER_MONTH;
    estimatedMonthlyCapacityPct = Math.round((messagesThisMonth / impliedMonthlyCapacityMessages) * 100);
  }

  return {
    messagesThisMonth,
    daysElapsedThisMonth: dayOfMonth,
    daysInMonth,
    dailyAverageThisMonth: dayOfMonth > 0 ? Math.round((messagesThisMonth / dayOfMonth) * 10) / 10 : 0,
    // Plain linear projection from the pace so far this month - not a
    // prediction that accounts for weekday patterns or anything fancier,
    // just "if this rate holds." Framed as a projection everywhere it's
    // shown, not a claim about a real limit.
    projectedMonthTotal: dayOfMonth > 0 ? Math.round((messagesThisMonth / dayOfMonth) * daysInMonth) : 0,
    messagesLastMonth,
    estimatedMonthlyCapacityPct,
  };
}

// ---------------------------------------------------------------------------
// Per-agent conversation list (the "Chats" panel)
// ---------------------------------------------------------------------------
//
// Every Agent Desktop agent's `.claude-session` cwd accumulates one
// `<sessionId>.jsonl` file per distinct conversation: a fresh one is started
// whenever the agent is opened with no prior session, and `/clear` (Reset
// Session) also starts a brand-new file rather than appending a marker (see
// getLiveTranscriptBlocks above for that discovery). Claude Code's own
// `--continue` always resumes whichever file has the most recent activity;
// `--resume <sessionId>` targets a specific one. This function turns that
// pile of files into a titled, dated list the renderer can show so the user
// can switch between past conversations or start a new one - the same
// mental model as claude.ai/code's "Recents", built from the same on-disk
// data Claude Code itself uses.
//
// Title precedence mirrors what Claude Code shows in its own /resume picker:
// a user-set custom title wins, then the AI-generated title, then a snippet
// of the first real user message, then a plain fallback. All three of
// custom-title / ai-title / agent-name are plain JSONL control records
// ({"type":"custom-title","customTitle":"..."} etc.) that can appear more
// than once in a file as the title changes over the session's life - the
// last occurrence of each is the current value.
function summarizeText(s, max) {
  const collapsed = String(s || "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}

function readConversationMeta(jsonlPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, "utf-8");
  } catch (e) {
    return null;
  }
  const fileSessionId = path.basename(jsonlPath, ".jsonl");
  let ownEarliestTs = Infinity; // earliest entry actually belonging to THIS session
  let anyEarliestTs = Infinity; // earliest entry at all (may be replayed history)
  let latestTs = -Infinity;
  let humanMessageCount = 0;
  let firstHumanText = "";
  let lastHumanText = "";
  let customTitle = "";
  let aiTitle = "";
  let sessionId = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (obj.sessionId) sessionId = obj.sessionId;
    if (obj.type === "custom-title" && typeof obj.customTitle === "string") customTitle = obj.customTitle;
    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") aiTitle = obj.aiTitle;
    let ts = NaN;
    if (obj.timestamp) {
      ts = new Date(obj.timestamp).getTime();
      if (!Number.isNaN(ts)) {
        if (ts < anyEarliestTs) anyEarliestTs = ts;
        if (ts > latestTs) latestTs = ts;
        // Resuming a conversation replays the prior transcript into the new
        // file with its original (old) timestamps, so the plain minimum
        // isn't "when this conversation started". Entries stamped with this
        // file's own session id are the ones that actually happened in it.
        if (obj.sessionId === fileSessionId && ts < ownEarliestTs) ownEarliestTs = ts;
      }
    }
    // A real human turn: type:"user" with origin.kind "human" (a tool_result
    // is also type:"user" but has no such origin) - same filter proven
    // correct in getLiveTranscriptBlocks / getUsageWindows.
    if (obj.type === "user" && obj.origin && obj.origin.kind === "human") {
      const text = extractText(obj.message && obj.message.content);
      if (text) {
        humanMessageCount++;
        if (!firstHumanText) firstHumanText = text;
        lastHumanText = text;
      }
    }
  }
  if (latestTs === -Infinity) return null; // empty / no real activity yet
  const title =
    summarizeText(customTitle, 120) ||
    summarizeText(aiTitle, 120) ||
    summarizeText(firstHumanText, 80) ||
    "(untitled conversation)";
  const titleSource = customTitle ? "custom" : aiTitle ? "ai" : firstHumanText ? "first-message" : "none";
  let startedAt = ownEarliestTs;
  if (startedAt === Infinity) startedAt = anyEarliestTs === Infinity ? latestTs : anyEarliestTs;
  return {
    sessionId: sessionId || fileSessionId,
    title,
    titleSource,
    // Where the conversation currently stands reads better on a "which one
    // do I want to resume" list than its opening line, which is often
    // replayed setup text - fall back to the first if there's only one.
    preview: summarizeText(lastHumanText || firstHumanText, 140),
    startedAt,
    lastActivityAt: latestTs,
    humanMessageCount,
  };
}

function listConversations(sessionCwd) {
  const metas = [];
  for (const jsonlPath of findJsonlFiles(sessionCwd)) {
    const meta = readConversationMeta(jsonlPath);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  // The most recently active conversation is the one `--continue` resumes,
  // i.e. what a plain "reopen this agent" lands on - flag it so the UI can
  // show which row is "current" without the renderer re-deriving the rule.
  if (metas.length) metas[0].isCurrent = true;
  return metas;
}

// A session id is always a UUID (hex + dashes). Enforced before it's ever
// used to build a file path so a malformed value from the renderer can't
// walk out of the project directory.
const SESSION_ID_RE = /^[0-9a-fA-F-]{16,64}$/;

// Rename a conversation by appending the same JSONL control records Claude
// Code's own `-n/--name` flag writes ({"type":"custom-title",...} plus
// {"type":"agent-name",...}). Appending rather than rewriting keeps the file
// an append-only log exactly as the CLI treats it, and the last occurrence
// wins on read (both here and in Claude Code itself). The new title reaches
// claude.ai/code the next time that conversation is the live Remote Control
// session, since the web reads the same records.
function setConversationTitle(sessionCwd, sessionId, title) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) {
    throw new Error("Invalid session id");
  }
  const clean = String(title || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
  if (!clean) throw new Error("Title cannot be empty");
  const jsonlPath = path.join(projectDirFor(sessionCwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) {
    throw new Error("Conversation file not found");
  }
  const lines =
    JSON.stringify({ type: "custom-title", customTitle: clean, sessionId }) +
    "\n" +
    JSON.stringify({ type: "agent-name", agentName: clean, sessionId }) +
    "\n";
  withFsRetry(() => fs.appendFileSync(jsonlPath, lines, "utf-8"));
  return { ok: true, title: clean };
}

module.exports = {
  syncArchive,
  listArchivedDays,
  readArchivedDay,
  encodeProjectPath,
  getLatestUsage,
  getUsageWindows,
  getLiveTranscriptBlocks,
  listConversations,
  setConversationTitle,
};

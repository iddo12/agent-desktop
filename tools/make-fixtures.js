#!/usr/bin/env node
// Builds the sandbox's fixture agents: fake agent folders plus synthetic
// transcripts in exactly the states that are awkward to produce on demand.
//
// WHY FIXTURES ARE THE MAIN EVENT. Most Agent Desktop bugs are not "Claude
// said the wrong thing" - they are "the UI reads a transcript in state X and
// renders the wrong thing". State X is usually something you cannot summon:
// a 500 from the API, a rate limit with a reset time, an expired login, a
// turn frozen mid-tool-call. Writing the transcript directly makes all of
// them reproducible in seconds, for free, deterministically, and needs no
// Claude process at all.
//
// The concrete case that prompted this: on 2026-09-22 a fix for
// "every API error reported as a usage limit" plus its auto-retry shipped
// unverified, because reproducing a 500 meant waiting for Anthropic to have
// one. The `halted-500` fixture below is that exact transcript.
//
// Fixture agents live under AGENT_DESKTOP_ROOT and their transcripts land in
// ~/.claude/projects/<encoded cwd>/ - a different encoded path from every
// real agent, because the encoding derives from the cwd, so they cannot
// collide with anything real.
//
//   node tools/make-fixtures.js            # build them all
//   node tools/make-fixtures.js --list     # show what would be built
//   node tools/make-fixtures.js --clean    # remove fixtures and transcripts

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT =
  process.env.AGENT_DESKTOP_ROOT ||
  path.join("E:", "Claude work", "Security", "AgentDesktopSandbox", "agents");

function encodeProjectPath(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

const uuid = () => crypto.randomUUID();
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

// --- transcript entry builders ---------------------------------------------

function userEntry(sessionId, cwd, text, mins) {
  return {
    type: "user",
    uuid: uuid(),
    sessionId,
    cwd,
    timestamp: ago(mins),
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantEntry(sessionId, cwd, text, mins, usage) {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId,
    cwd,
    timestamp: ago(mins),
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text }],
      usage: Object.assign(
        { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 24000 },
        usage || {}
      ),
      stop_reason: "end_turn",
    },
  };
}

// An assistant tool_use with no matching tool_result is what the stuck-turn
// watchdog reads as "still working" - the shape that once had an agent
// showing "Working... 1594s" with no process left alive.
function danglingToolUse(sessionId, cwd, mins) {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId,
    cwd,
    timestamp: ago(mins),
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "tool_use", id: "toolu_" + uuid().slice(0, 12), name: "Bash", input: { command: "sleep 99999" } }],
      usage: { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 12000 },
    },
  };
}

// Copied field-for-field from the real 500 that stopped the Product
// Development Agent on 2026-09-22 - error "server_error", apiErrorStatus 500,
// and crucially NO quotaLimits, which is what made the old code call it a
// usage limit.
function haltServerError(sessionId, cwd, mins) {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId,
    cwd,
    timestamp: ago(mins),
    isApiErrorMessage: true,
    error: "server_error",
    apiErrorStatus: 500,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: 500 Internal server error. This is a server-side issue, usually temporary." }],
    },
  };
}

function haltRateLimit(sessionId, cwd, mins, resetsInMins) {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId,
    cwd,
    timestamp: ago(mins),
    isApiErrorMessage: true,
    error: "rate_limit",
    apiErrorStatus: 429,
    // Anthropic reports resetsAt in epoch SECONDS - the app normalises it.
    quotaLimits: { rateLimitType: "5-hour", resetsAt: Math.floor((Date.now() + resetsInMins * 60000) / 1000) },
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "Claude usage limit reached." }],
    },
  };
}

function haltAuthFailed(sessionId, cwd, mins) {
  return {
    type: "assistant",
    uuid: uuid(),
    sessionId,
    cwd,
    timestamp: ago(mins),
    isApiErrorMessage: true,
    error: "authentication_failed",
    apiErrorStatus: 401,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: 401 authentication_failed." }],
    },
  };
}

// --- the fixtures ----------------------------------------------------------

const FIXTURES = [
  {
    folder: "FIX Healthy",
    role: "Baseline - a normal finished conversation",
    build: (s, c) => [
      userEntry(s, c, "Summarise where we got to.", 12),
      assistantEntry(s, c, "We finished the router and queued three tasks.", 11),
    ],
  },
  {
    folder: "FIX Halted 500",
    role: "Turn killed by a transient API error (the 2026-09-22 case)",
    build: (s, c) => [
      userEntry(s, c, "A few things: pull the logos, then check the meter.", 6),
      haltServerError(s, c, 5),
    ],
  },
  {
    folder: "FIX Halted RateLimit",
    role: "Real usage limit, resets in 25 minutes",
    build: (s, c) => [
      userEntry(s, c, "Carry on with the audit.", 9),
      haltRateLimit(s, c, 8, 25),
    ],
  },
  {
    folder: "FIX Halted RateLimit Past",
    role: "Usage limit whose window already reset - must NOT show as stopped",
    build: (s, c) => [
      userEntry(s, c, "Carry on with the audit.", 400),
      haltRateLimit(s, c, 395, -60),
    ],
  },
  {
    folder: "FIX Auth Expired",
    role: "Login expired - must not be reported as a usage limit",
    build: (s, c) => [
      userEntry(s, c, "Run the daily report.", 20),
      haltAuthFailed(s, c, 19),
    ],
  },
  {
    folder: "FIX Stuck Turn",
    role: "Dangling tool_use - reads as working forever",
    build: (s, c) => [
      userEntry(s, c, "Check the NAS disks.", 45),
      danglingToolUse(s, c, 44),
    ],
  },
  {
    folder: "FIX Near Context",
    role: "Large context, for the context badge and handoff threshold",
    build: (s, c) => [
      userEntry(s, c, "Keep going.", 30),
      assistantEntry(s, c, "Continuing.", 29, {
        input_tokens: 4000,
        output_tokens: 1200,
        cache_read_input_tokens: 168000,
        cache_creation_input_tokens: 2000,
      }),
    ],
  },
  // Added 2026-10-02 for the "Restart agents" fleet-wide picker (see
  // CLAUDE.md v1.60.8+) - its busy-skip and paused-unchecked paths both need
  // a real fixture to click-test, which neither existing fixture provides:
  // "FIX Stuck Turn" looks busy by transcript alone, but getSessionActivity()
  // also cross-checks the daemon pid file (see archive.js
  // finishSessionActivity) and flips working back to false when that file is
  // missing - true for every fixture here, none of which has a real `claude
  // --bg` process. `pidAlive: true` below writes a pid file pointing at PID 4
  // ("System" on Windows, always present) so that check passes: `process.kill
  // (4, 0)` throws EPERM, not ESRCH, which the real code only treats as
  // "flip to not-working" for ESRCH specifically - any other error leaves the
  // transcript's "still working" answer alone. It's a signal-0 existence
  // check only, never an actual kill, so this is inert.
  {
    folder: "FIX Busy",
    role: "Mid-turn with a live-looking process - getSessionActivity() must read this as working",
    pidAlive: true,
    // Fixed (not random) so build/clean always target the same pid file -
    // see pidFileFor() below.
    fixedSessionId: "deadbeef-0000-4000-8000-000000000001",
    build: (s, c) => [
      userEntry(s, c, "Keep going with the audit.", 2),
      danglingToolUse(s, c, 1),
    ],
  },
  {
    folder: "FIX Paused",
    role: "Deliberately paused - Restart All must leave it unchecked by default",
    configOverrides: { paused: true },
    build: (s, c) => [
      userEntry(s, c, "Summarise where we got to.", 60),
      assistantEntry(s, c, "Done for now - pausing until Iddo says go.", 59),
    ],
  },
];

// --- build / clean ---------------------------------------------------------

function sessionCwdFor(folder) {
  return path.join(ROOT, folder, ".claude-session");
}
function projectDirFor(folder) {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectPath(sessionCwdFor(folder)));
}
// Mirrors archive.js finishSessionActivity's own pid-file path exactly - the
// daemon pid file it cross-checks before trusting a transcript's "still
// working" read. See the FIX Busy fixture above.
function pidFileFor(sessionId) {
  return path.join(os.homedir(), ".claude", "daemon", "pty-pids", `${String(sessionId).split("-")[0]}.pid`);
}
// Signal 0 only tests whether the pid exists/is reachable - it never
// actually signals the process. PID 4 is "System" on Windows: always
// present, and protected, so this throws EPERM (not ESRCH) - the one error
// finishSessionActivity does NOT treat as "process is gone".
const ALWAYS_ALIVE_PID = 4;

function build() {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const fx of FIXTURES) {
    const agentDir = path.join(ROOT, fx.folder);
    const sessionCwd = sessionCwdFor(fx.folder);
    fs.mkdirSync(sessionCwd, { recursive: true });

    fs.writeFileSync(
      path.join(agentDir, "agent_config.json"),
      JSON.stringify(Object.assign({ display_name: fx.folder, role: fx.role, avatar: null }, fx.configOverrides || {}), null, 2),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(agentDir, "CLAUDE.md"),
      `# ${fx.folder}\n\nSandbox fixture. ${fx.role}\n\nThis agent is not real. Its transcript was generated by\n` +
        "`tools/make-fixtures.js` to put the UI into a specific state. Nothing here\n" +
        "should ever be dispatched against the live Claude account.\n",
      "utf-8"
    );

    const sessionId = fx.fixedSessionId || uuid();
    const projectDir = projectDirFor(fx.folder);
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = fx.build(sessionId, sessionCwd).map((e) => JSON.stringify(e));
    // The name records the app's own re-pin sweep would otherwise have to add.
    lines.unshift(JSON.stringify({ type: "custom-title", customTitle: fx.folder, sessionId }));
    lines.unshift(JSON.stringify({ type: "agent-name", agentName: fx.folder, sessionId }));
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf-8");

    if (fx.pidAlive) {
      const pidFile = pidFileFor(sessionId);
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, String(ALWAYS_ALIVE_PID), "utf-8");
    }

    console.log(`built  ${fx.folder}\n       ${projectDir}`);
  }
  console.log(`\n${FIXTURES.length} fixtures under ${ROOT}`);
}

function clean() {
  for (const fx of FIXTURES) {
    const targets = [path.join(ROOT, fx.folder), projectDirFor(fx.folder)];
    if (fx.pidAlive && fx.fixedSessionId) targets.push(pidFileFor(fx.fixedSessionId));
    for (const target of targets) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`removed ${target}`);
      } catch (e) {
        console.error(`could not remove ${target}: ${e.message}`);
      }
    }
  }
}

const arg = process.argv[2];
if (arg === "--clean") clean();
else if (arg === "--list") FIXTURES.forEach((f) => console.log(`${f.folder.padEnd(26)} ${f.role}`));
else build();

// Sandbox / test-instance support (2026-09-22).
//
// WHY THIS EXISTS. Changes to this app could not be tested without restarting
// Iddo's live instance, so fixes were shipping unverified - two went out the
// night before this was written with "I could not test this end to end"
// attached. A second, disposable instance fixes that, and is a prerequisite
// for a software-development agent that works unattended: an agent that
// cannot test its own changes will ship regressions into the app Iddo uses
// all day.
//
// WHY A PLAIN COPY WOULD BE DANGEROUS. Agent Desktop is not self-contained.
// Two of its background sweeps act on the whole machine:
//
//   - reapOrphanedBackgroundAgentProcesses() enumerates EVERY claude process
//     and kills any pty-host it does not recognise. A second instance with a
//     different agent roster would not recognise the real agents, and would
//     kill them.
//   - ensureAllAgentsBackgrounded() dispatches a real `claude --bg` process
//     per agent, spending real quota, and re-pins conversation names.
//
// So the isolation that matters is not a copied folder - it is these sweeps
// refusing to run. They are OFF in test mode and require a second, explicit
// opt-in to turn on, deliberately: the failure mode of getting that backwards
// is a test instance killing live agents.
//
// THREE TIERS, matching what was agreed:
//   1. Test mode      - separate agent root + userData, dangerous sweeps off.
//   2. Fixtures       - synthetic transcripts (tools/make-fixtures.js). Most
//                       bugs are a transcript in a particular state, so this
//                       covers the majority, costs nothing and is repeatable.
//   3. Live agent     - a real throwaway agent, off by default, metered
//                       against a hard token budget (see below).
//
// THE BUDGET IS IDDO'S CONDITION FOR TIER 3, and is mechanical rather than a
// matter of judgement: "use this testing agent very conservatively - maybe
// limit its token use and ask me when it exceeds a certain low amount."

const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_MODE = process.env.AGENT_DESKTOP_TEST_MODE === "1";

// Tier 3. Only meaningful in test mode - this can never turn live dispatch on
// for the real instance, and in the real instance it is ignored entirely.
const ALLOW_LIVE_AGENTS =
  TEST_MODE && process.env.AGENT_DESKTOP_ALLOW_LIVE_AGENTS === "1";

// Deliberately low. Roughly a handful of real exchanges - enough to prove a
// live agent starts, answers and shows up correctly in the UI, not enough to
// run an experiment for an hour without anyone noticing.
const DEFAULT_TOKEN_BUDGET = 150000;
const TOKEN_BUDGET = (() => {
  const raw = parseInt(process.env.AGENT_DESKTOP_TEST_TOKEN_BUDGET || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOKEN_BUDGET;
})();

// Warn on the way up rather than only at the wall, so there is a chance to
// stop something wasteful before the budget is gone.
const WARN_AT_FRACTION = 0.6;

function sandboxRoot() {
  return process.env.AGENT_DESKTOP_ROOT || null;
}

// Kept beside the sandbox agents rather than in userData: it is state about
// the sandbox, and deleting the sandbox folder should take it with it.
function statePath() {
  const root = sandboxRoot();
  return root ? path.join(root, ".sandbox-state.json") : null;
}

function readState() {
  const p = statePath();
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return {};
  }
}

function writeState(state) {
  const p = statePath();
  if (!p) return;
  try {
    fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    /* budget bookkeeping must never be why the app fails to start */
  }
}

// Mirrors archive.js's encodeProjectPath so this module stays standalone -
// it must be safe to require from a plain node script (the fixture builder)
// with no Electron app object in scope.
function encodeProjectPath(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function projectsRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Tokens spent by every agent under the sandbox root.
 *
 * Counts input + output + cache-creation, and reports cache reads separately:
 * a cache read is the cheap path and counting it against a budget would make
 * a long conversation look far more expensive than it is.
 *
 * Reads transcripts directly rather than any running-process API so it works
 * for agents that have since exited, and so the figure survives a restart.
 */
function tokensUsed() {
  const root = sandboxRoot();
  if (!root) return { billable: 0, cacheRead: 0, agents: 0 };

  let billable = 0;
  let cacheRead = 0;
  let agents = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return { billable: 0, cacheRead: 0, agents: 0 };
  }

  for (const dir of dirs) {
    const sessionCwd = path.join(root, dir.name, ".claude-session");
    const projectDir = path.join(projectsRoot(), encodeProjectPath(sessionCwd));
    let files = [];
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch (e) {
      continue;
    }
    if (files.length) agents += 1;
    for (const file of files) {
      let raw;
      try {
        raw = fs.readFileSync(path.join(projectDir, file), "utf-8");
      } catch (e) {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.includes('"usage"')) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (e) {
          continue;
        }
        const u = obj && obj.message && obj.message.usage;
        if (!u) continue;
        billable += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
        cacheRead += u.cache_read_input_tokens || 0;
      }
    }
  }
  return { billable, cacheRead, agents };
}

/**
 * Budget verdict. `state` is one of:
 *   "ok"        - under the warning threshold
 *   "warn"      - past WARN_AT_FRACTION, worth mentioning once
 *   "exceeded"  - stop live agents and ask Iddo
 */
function budgetStatus() {
  const { billable, cacheRead, agents } = tokensUsed();
  const fraction = TOKEN_BUDGET > 0 ? billable / TOKEN_BUDGET : 0;
  let state = "ok";
  if (billable >= TOKEN_BUDGET) state = "exceeded";
  else if (fraction >= WARN_AT_FRACTION) state = "warn";
  return { state, billable, cacheRead, agents, budget: TOKEN_BUDGET, fraction };
}

// True once the budget is gone. Callers must treat this as a hard stop for
// anything that would spend more, not as advice.
function budgetExhausted() {
  return ALLOW_LIVE_AGENTS && budgetStatus().state === "exceeded";
}

// May this instance spawn or keep alive real `claude --bg` processes?
// Three conditions, all required: test mode, the explicit live opt-in, and
// budget remaining.
function liveAgentsPermitted() {
  if (!TEST_MODE) return true;          // the real instance is unaffected
  if (!ALLOW_LIVE_AGENTS) return false; // tiers 1-2: fixtures only
  return !budgetExhausted();
}

// May this instance kill Claude processes it does not recognise? Never in
// test mode - the roster differs, so "unrecognised" would include the real
// agents. There is deliberately no opt-in for this one.
function processReapingPermitted() {
  return !TEST_MODE;
}

function describe() {
  if (!TEST_MODE) return "live instance";
  const parts = ["TEST MODE", `root=${sandboxRoot() || "(unset!)"}`];
  parts.push(ALLOW_LIVE_AGENTS ? `live agents ON (budget ${TOKEN_BUDGET} tokens)` : "live agents OFF (fixtures only)");
  return parts.join(" | ");
}

module.exports = {
  TEST_MODE,
  ALLOW_LIVE_AGENTS,
  TOKEN_BUDGET,
  WARN_AT_FRACTION,
  sandboxRoot,
  encodeProjectPath,
  tokensUsed,
  budgetStatus,
  budgetExhausted,
  liveAgentsPermitted,
  processReapingPermitted,
  readState,
  writeState,
  describe,
};

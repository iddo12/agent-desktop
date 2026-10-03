// v1.69.4: classifiers for "what does the agent's CLI screen show right now", used by the stuck-Enter recovery
// ladder (connectionHealth.js), the Enter / dialog guards and the failure diagnostics (main.js).
// Input is main's `dialogTails` text: the CLI's pty output with OSC/CSI codes removed (cursor-forward moves vanish,
// so spaces are unreliable and every pattern here is matched on whitespace-squashed text).
// Patterns come from real Claude Code 2.1.x screens captured with a node-pty harness (tests/fixtures/screens.json).
"use strict";

function stripTerminalCodes(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}
const squash = (s) => String(s || "").replace(/\s+/g, "");

const DIALOG_SQ = /Doyouwanttoproceed|Esctocancel|Entertoconfirm|❯1\.Yes|\(y\/n\)|\[Y\/n\]/i;
const QUEUED_SQ = /queuedmessages/i;
const WORKING_SQ = /esctointerrupt/i;
const CTRLC_AGAIN_SQ = /PressCtrl-Cagain/i;

// the part of the screen that comes after the last occurrence of the typed text (or the last 600 chars when the
// text is not found): a footer / dialog that is relevant to THIS message sits there, older ones do not
function afterSnippet(tail, snippet) {
  const t = squash(tail);
  const want = squash(snippet).slice(-40);
  if (want.length >= 3) {
    const i = t.lastIndexOf(want);
    if (i >= 0) return t.slice(i + want.length);
  }
  return t.slice(-600);
}
const isDialog = (tail, snippet) => DIALOG_SQ.test(afterSnippet(tail, snippet)) || DIALOG_SQ.test(squash(tail).slice(-250));
// the footer must be in the CURRENT screen: within the last 500 characters after the typed text (a stale footer left in the
// stream, followed by later output, does not count)
const isQueued = (tail, snippet) => QUEUED_SQ.test(afterSnippet(tail, snippet).slice(-500));
const isWorkingScreen = (tail, snippet) => WORKING_SQ.test(afterSnippet(tail, snippet));
const ctrlCAgainShown = (tail) => CTRLC_AGAIN_SQ.test(squash(tail).slice(-400));
const hasSnippet = (tail, snippet) => {
  const want = squash(snippet).slice(-40);
  return want.length >= 3 && squash(tail).slice(-1200).includes(want);
};

// The text sits unsent in the CLI input box: on screen, and followed by no dialog, no queued-messages footer
// and no working indicator (a message the CLI queued or already submitted also shows as "> text").
function inputHolds(tail, snippet) {
  if (!hasSnippet(tail, snippet)) return false;
  return !isDialog(tail, snippet) && !isQueued(tail, snippet) && !isWorkingScreen(tail, snippet);
}

// v1.69.4: is the `claude attach` pty itself alive and showing the CLI? Live case 2026-10-04 (SE + COO agents): the
// Terminal tab was BLANK, typing did nothing, while `claude logs <id>` showed a healthy idle CLI with the message sitting
// in its input box. Cheap signals only, all already known to main: pty object gone; no output at all since the attach
// (a healthy attach always redraws the CLI). Returns null (looks alive) or a reason string.
// o: { alive, now, attachedAt, dataBytes, graceMs }  (dataBytes is seeded with the attach peek buffer: an idle CLI draws once)
function attachHealth(o) {
  if (!o.alive) return "pty-gone";
  if (o.now - (o.attachedAt || 0) < (o.graceMs == null ? 15000 : o.graceMs)) return null; // a fresh attach is still drawing
  if (!o.dataBytes) return "no-output-since-attach";
  return null;
}
// The typed text is followed by blank line(s) before the box's bottom rule: Enter keys went in as newlines.
function stackedNewlines(tail, snippet) {
  const t = stripTerminalCodes(tail);
  const want = String(snippet || "").trim().slice(-20);
  if (want.length < 3) return false;
  const i = t.lastIndexOf(want);
  if (i < 0) return false;
  return /^[ \t]*(\r?\n[ \t]*){2,}\u2500{5}/.test(t.slice(i + want.length));
}

// cause for the logs: queued (footer on the CURRENT screen only) / working / dialog / unsent-box / box-empty-no-ack / dead-pty / dead-attach
function classify(tail, snippet, o) {
  if (o && o.deadPty) return "dead-pty";
  if (o && o.deadAttach) return "dead-attach";
  if (isDialog(tail, snippet)) return "dialog";
  if (isQueued(tail, snippet)) return "queued";
  if ((o && o.working) || isWorkingScreen(tail, snippet)) return "working";
  if (hasSnippet(tail, snippet)) return "unsent-box";
  return "box-empty-no-ack";
}

// Same secret shapes logSentInput redacts (API keys / bearer tokens / key=value secrets).
function redactSecrets(text) {
  return String(text)
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}
// last ~n lines of the screen text, ANSI-free, secrets redacted, bounded, for the watchdog log. `omit` = the user's own message
// text (what sits in the unsent box): every line of it is replaced by [msg], so a log line never holds what Iddo typed.
function lastLines(tail, n, maxChars, omit) {
  let t = stripTerminalCodes(tail).replace(/\r/g, "\n");
  if (omit) {
    for (const ln of String(omit).split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length >= 3).sort((a, b) => b.length - a.length)) {
      t = t.split(ln).join("[msg]");
    }
  }
  const lines = t.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  return redactSecrets(lines.slice(-(n || 25)).join(" | ").slice(-(maxChars || 1500)));
}

// v1.69.4 (experiment 2026-10-04, real `claude --bg` + `claude attach`): the attach client can be dead without any error.
//  - kicked: a second `claude attach` to the same session makes the older client print "Session opened in another window" and exit
//  - detached: two Ctrl+C in a few seconds on an empty box detach the client; the screen goes blank, input then goes to the
//    `claude agents` dashboard ("describe a task for a new session", "enter to return")
// Evidence on the CURRENT screen (last 800 chars, whitespace squashed): "kicked" | "dashboard" | null.
function attachEvidence(tail) {
  const t = squash(tail).slice(-800);
  if (/Sessionopenedinanotherwindow/i.test(t)) return "kicked";
  if (/describeataskforanewsession|entertoreturn/i.test(t)) return "dashboard";
  return null;
}
// Do two screens show different CLI content? (attach tail vs `claude logs` text): most of the logs' substantial lines are missing from the attach screen
function screensDiffer(attachTail, logsText) {
  const a = squash(stripTerminalCodes(attachTail));
  const lines = String(logsText || "").split(/\r?\n/).map(squash).filter((l) => l.length >= 15 && !/^[\u2500-]+$/.test(l));
  if (lines.length < 2) return false; // logs show nothing to compare against
  const missing = lines.filter((l) => !a.includes(l)).length;
  return missing >= Math.max(2, Math.ceil(lines.length / 2));
}

// a message ending in a backslash would insert a newline instead of submitting
const fixTrailingBackslash = (text) => (/\\$/.test(String(text)) ? text + " " : text);

module.exports = { redactSecrets, attachEvidence, screensDiffer, attachHealth, stackedNewlines, stripTerminalCodes, squash, isDialog, isQueued, isWorkingScreen, ctrlCAgainShown, hasSnippet, inputHolds, classify, lastLines, fixTrailingBackslash };

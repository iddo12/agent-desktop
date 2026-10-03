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
const isQueued = (tail, snippet) => QUEUED_SQ.test(afterSnippet(tail, snippet));
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

// cause for the logs: queued / dialog / unsent-box / box-empty-no-ack / dead-pty
function classify(tail, snippet, o) {
  if (o && o.deadPty) return "dead-pty";
  if (isDialog(tail, snippet)) return "dialog";
  if (isQueued(tail, snippet) || (o && o.working) || isWorkingScreen(tail, snippet)) return "queued";
  if (hasSnippet(tail, snippet)) return "unsent-box";
  return "box-empty-no-ack";
}

// last ~n lines of the screen text, ANSI-free and bounded, for the watchdog log
function lastLines(tail, n, maxChars) {
  const lines = stripTerminalCodes(tail).replace(/\r/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  return lines.slice(-(n || 25)).join(" | ").slice(-(maxChars || 1500));
}

// a message ending in a backslash would insert a newline instead of submitting
const fixTrailingBackslash = (text) => (/\\$/.test(String(text)) ? text + " " : text);

module.exports = { stripTerminalCodes, squash, isDialog, isQueued, isWorkingScreen, ctrlCAgainShown, hasSnippet, inputHolds, classify, lastLines, fixTrailingBackslash };

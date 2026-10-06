#!/usr/bin/env node
// Compares the tail-ranked transcript readers (v1.76.0, src/archive.js) with a
// reference implementation that parses every file in full, on real agent
// folders. Read-only. Exit code 1 on any difference.
//
//   node tools/compare-archive-readers.js                 # every agent under the workspace root
//   node tools/compare-archive-readers.js "COO Agent" ... # named agents only
//   AGENT_DESKTOP_ROOT=... node tools/compare-archive-readers.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const archive = require("../src/archive");

const ROOT = process.env.AGENT_DESKTOP_ROOT || path.resolve(__dirname, "..", "..");
const enc = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, "-");
const projDir = (cwd) => path.join(require("os").homedir(), ".claude", "projects", enc(cwd));
const listJsonl = (cwd) => { try { return fs.readdirSync(projDir(cwd)).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(projDir(cwd), f)); } catch (e) { return []; } };

// --- reference readers: the pre-1.76.0 logic, every file parsed in full ----
function refActivity(cwd) {
  let best = null;
  for (const p of listJsonl(cwd)) {
    const st = archive.__readActivityFileForTest(p); // full forward parse of this file (same per-file reader)
    if (st && st.latestTs > (best ? best.latestTs : -Infinity)) best = st;
  }
  if (!best) return { lastHumanTs: null, lastEndTurnTs: null, last: null, lastSessionId: null };
  return { lastHumanTs: best.lastHumanTs, lastEndTurnTs: best.lastEndTurnTs, last: best.last, lastSessionId: best.lastSessionId };
}
function refUsage(cwd) {
  let latest = null;
  for (const p of listJsonl(cwd)) {
    const u = archive.__readUsageFileForTest(p);
    if (u && (!latest || new Date(u.timestamp) > new Date(latest.timestamp))) latest = u;
  }
  return latest;
}
// Blocks: the reference ranks files by a FULL parse of every file (what the old code did) and then
// builds blocks from the top two with the shared blocksFromEntries - the new code must agree.
function fullParseLatestTs(p) {
  const text = fs.readFileSync(p, "utf-8");
  let latest = -Infinity;
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop(); // the old reader only folded complete lines
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o.timestamp) continue;
    const t = new Date(o.timestamp).getTime();
    if (t > latest) latest = t;
  }
  return latest;
}
function refBlocksRanking(cwd) {
  return listJsonl(cwd).map((p) => ({ p, ts: fullParseLatestTs(p) })).sort((a, b) => b.ts - a.ts).slice(0, 2).map((x) => x.p);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, "agent_config.json")) && fs.existsSync(path.join(ROOT, e.name, ".claude-session")))
  .map((e) => e.name);
let failures = 0;
for (const n of names) {
  const cwd = path.join(ROOT, n, ".claude-session");
  const files = listJsonl(cwd);
  const t0 = Date.now();
  const act = archive.getSessionActivity(cwd);
  const usage = archive.getLatestUsage(cwd);
  const blocks = archive.getLiveTranscriptBlocks(cwd);
  const newMs = Date.now() - t0;
  const t1 = Date.now();
  const ra = refActivity(cwd);
  const ru = refUsage(cwd);
  const rb = refBlocksRanking(cwd);
  const refMs = Date.now() - t1;
  const problems = [];
  // activity: compare the raw summary fields (finishSessionActivity adds the pid probe, same in both)
  const na = archive.__readActivitySummaryForTest(cwd);
  try { assert.deepStrictEqual(na, ra); } catch (e) { problems.push("activity: " + e.message.split("\n").slice(0, 6).join(" | ")); }
  try { assert.deepStrictEqual(usage, ru); } catch (e) { problems.push("usage: " + e.message.split("\n").slice(0, 6).join(" | ")); }
  const nb = archive.__rankFilesByTailForTest(files).slice(0, 2).map((x) => x.jsonlPath);
  try { assert.deepStrictEqual(nb, rb); } catch (e) { problems.push("blocks top-2 ranking: new=" + nb.map((p) => path.basename(p)).join(",") + " ref=" + rb.map((p) => path.basename(p)).join(",")); }
  if (problems.length) { failures++; console.log(`DIFF ${n}:\n  ` + problems.join("\n  ")); }
  else console.log(`ok   ${n.padEnd(40)} files=${String(files.length).padStart(3)} blocks=${String(blocks.length).padStart(4)} working=${!!(act && act.working)} ctx=${usage ? usage.contextTokens : "-"}  new=${newMs}ms ref=${refMs}ms`);
}
console.log(failures ? `${failures} agent(s) differ` : `all ${names.length} agents identical`);
process.exit(failures ? 1 : 0);

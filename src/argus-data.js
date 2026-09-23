// Data for ARGUS - the Bridge (v1.39.0; COO brief v1.40.0): one screen with every agent's report,
// the Decision Queue and the ideas board. Iddo named it 2026-09-22 ("Argus",
// the hundred-eyed watchman, and "the Bridge" for what it does).
//
// Everything comes from files the agents already write, normalised into one
// format by shared_tools\bridge\build_status.py:
//   shared_reports\status\<agent>.json   one per agent ("agent-status/1")
//   shared_reports\status\_fleet.json    usage, scheduled jobs, run costs
//   shared_reports\status\_decisions.json the Decision Queue (heuristic, or the
//                                         COO's ranked queue when it is current)
//   shared_reports\coo\brief_latest.json  the COO's bottom line for today
//   shared_reports\recommendations\<week>\<agent>.json  weekly ideas
// This module refreshes those files (runs the builder) and reads them. It never
// writes anything an agent owns.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, "")); } catch (e) { return null; }
}

function runBuilder(workspace) {
  const script = path.join(workspace, "shared_tools", "bridge", "build_status.py");
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) return resolve({ ok: false, error: "build_status.py not found" });
    execFile("python", [script], { cwd: path.dirname(script), windowsHide: true, timeout: 60000,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }) },
      (err, stdout, stderr) => resolve({ ok: !err, output: String(stdout || "") + String(stderr || "") }));
  });
}

function latestRecommendations(workspace) {
  const dir = path.join(workspace, "shared_reports", "recommendations");
  let weeks = [];
  try { weeks = fs.readdirSync(dir).filter((w) => /^\d{4}-W\d{2}$/.test(w)).sort(); } catch (e) { return { week: null, items: [] }; }
  const week = weeks[weeks.length - 1];
  if (!week) return { week: null, items: [] };
  const items = [];
  for (const f of fs.readdirSync(path.join(dir, week)).filter((n) => n.endsWith(".json"))) {
    const r = readJson(path.join(dir, week, f));
    if (r && Array.isArray(r.items)) items.push(r);
  }
  return { week, items };
}

// The COO agent's daily brief (v1.40.0). Only today's brief speaks for today:
// an older one is returned with stale:true so the view can say so and fall back
// to its own mechanical line, rather than presenting yesterday as now.
function cooBrief(workspace) {
  const file = path.join(workspace, "shared_reports", "coo", "brief_latest.json");
  const b = readJson(file);
  if (!b || !b.bottomLine) return null;
  const today = new Date().toLocaleDateString("en-CA");
  // "Written at" comes from the file, not from the brief's own generatedAt:
  // the first run (2026-09-22) claimed 20:30 for a job that ran at 20:15, and
  // a model-supplied clock reading is not evidence of anything.
  let writtenAt = null;
  try { writtenAt = fs.statSync(file).mtime.toISOString(); } catch (e) { /* keep null */ }
  return Object.assign({}, b, { stale: b.date !== today, writtenAt });
}

// The week's research: what each agent learned, and the COO's cut of what is
// actually worth Iddo's attention (v1.44.0). Two separate things deliberately
// - the agents flag generously, the COO cuts hard to about five items, and
// the unfiltered pile stays readable underneath rather than being thrown away.
function weeklyResearch(workspace) {
  const dir = path.join(workspace, "shared_reports", "research");
  let weeks = [];
  try { weeks = fs.readdirSync(dir).filter((w) => /^\d{4}-W\d{2}$/.test(w)).sort(); } catch (e) { return null; }
  const week = weeks[weeks.length - 1];
  if (!week) return null;
  const digests = [];
  for (const f of fs.readdirSync(path.join(dir, week)).filter((n) => n.endsWith(".json"))) {
    const d = readJson(path.join(dir, week, f));
    if (d && Array.isArray(d.findings)) digests.push(d);
  }
  const coo = readJson(path.join(workspace, "shared_reports", "coo", "weekly_" + week + ".json"));
  return {
    week,
    digests,
    // The COO's cut when it has run; otherwise everything the agents flagged,
    // labelled as unfiltered so the difference is never silently blurred.
    worthKnowing: coo && Array.isArray(coo.worthKnowing) ? coo.worthKnowing : null,
    cooHeadline: coo ? coo.headline || null : null,
    flagged: digests.flatMap((d) => (d.findings || [])
      .filter((f) => f.worthIddoKnowing)
      .map((f) => Object.assign({ agent: d.agent }, f))),
    spent: digests.reduce((a, d) => a + (Number(d.spentUsd) || 0), 0),
    budget: digests.reduce((a, d) => a + (Number(d.budgetUsd) || 0), 0),
  };
}

async function getArgusData(workspace, { refresh = true } = {}) {
  const status = path.join(workspace, "shared_reports", "status");
  const build = refresh ? await runBuilder(workspace) : { ok: true };
  let agents = [];
  try {
    agents = fs.readdirSync(status)
      .filter((n) => n.endsWith(".json") && !n.startsWith("_"))
      .map((n) => readJson(path.join(status, n)))
      .filter(Boolean);
  } catch (e) { /* no status yet */ }
  return {
    builtOk: build.ok,
    buildError: build.ok ? null : build.error || build.output,
    agents,
    fleet: readJson(path.join(status, "_fleet.json")) || {},
    decisions: (readJson(path.join(status, "_decisions.json")) || {}).items || [],
    decisionsBuiltBy: (readJson(path.join(status, "_decisions.json")) || {}).builtBy || null,
    brief: cooBrief(workspace),
    // How well the usage meter is doing against reality (2026-09-23). Iddo
    // asked for it weekly, with the improvement on last week - the same
    // "every number needs a comparison" rule applied to the number that
    // measures everything else. Written by the System Optimization agent.
    usageAccuracy: readJson(path.join(status, "_usage_accuracy.json")),
    recommendations: latestRecommendations(workspace),
    research: weeklyResearch(workspace),
  };
}

// Opening the file behind a number (v1.42.0). The renderer asks for a path,
// but the renderer is never trusted with one: the request is honoured only if
// that exact path appears as a links.* value inside one of the status files
// this module already publishes. Same rule as the Library's `view` action - a
// path from the renderer is a claim, not an authorisation.
function sourcePaths(workspace) {
  const dir = path.join(workspace, "shared_reports", "status");
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("_")); } catch (e) { return out; }
  for (const n of names) {
    const links = (readJson(path.join(dir, n)) || {}).links || {};
    for (const v of Object.values(links)) if (typeof v === "string" && v) out.add(path.resolve(v));
  }
  return out;
}

async function openSource(workspace, requested) {
  const p = path.resolve(String(requested || ""));
  if (!sourcePaths(workspace).has(p)) return { ok: false, error: "Not a known report file." };
  if (!fs.existsSync(p)) return { ok: false, error: "That file does not exist yet - the agent has not written it." };
  const err = await require("electron").shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
}

// Recording Iddo's verdict on an idea (v1.44.0). This is the keystone of the
// research programme: an agent is told to keep only the sources that keep
// being useful, and "useful" can only mean "produced something he approved".
// Without this write the loop is open and every source looks equally good
// forever. Validated hard, because it is the renderer's only write path into
// an agent-owned file: the week must look like a week, the agent must be one
// that exists, the id must already be in that file, and the verdict must be
// one of three words. Nothing else in the file is touched.
const VERDICTS = ["approved", "parked", "rejected", "none"];

function setIdeaDecision(workspace, { week, agent, id, verdict, note }) {
  if (!/^\d{4}-W\d{2}$/.test(String(week || ""))) return { ok: false, error: "Bad week." };
  if (!VERDICTS.includes(String(verdict))) return { ok: false, error: "Unknown verdict." };
  const safeAgent = String(agent || "");
  // Rejects separators in either direction and any dot-dot, so an agent name
  // can never walk out of the recommendations folder.
  if (!safeAgent || /[\\/:*?"<>|]/.test(safeAgent) || safeAgent.includes("..")) {
    return { ok: false, error: "Bad agent." };
  }
  const file = path.join(workspace, "shared_reports", "recommendations", String(week), safeAgent + ".json");
  if (!fs.existsSync(file)) return { ok: false, error: "No ideas file for that agent this week." };
  const doc = readJson(file);
  if (!doc || !Array.isArray(doc.items)) return { ok: false, error: "That ideas file is unreadable." };
  const item = doc.items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "No idea with that id." };
  if (verdict === "none") delete item.decision;
  else item.decision = { verdict, at: new Date().toISOString(), note: note ? String(note).slice(0, 500) : undefined };
  try {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf-8");
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return { ok: true, verdict };
}

// Cheap count for the header badge - no rebuild, just the last file.
function getDecisionCount(workspace) {
  const d = readJson(path.join(workspace, "shared_reports", "status", "_decisions.json"));
  return d && Array.isArray(d.items) ? d.items.length : 0;
}

module.exports = { getArgusData, getDecisionCount, openSource, setIdeaDecision };

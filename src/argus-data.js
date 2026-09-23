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
    recommendations: latestRecommendations(workspace),
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

// Cheap count for the header badge - no rebuild, just the last file.
function getDecisionCount(workspace) {
  const d = readJson(path.join(workspace, "shared_reports", "status", "_decisions.json"));
  return d && Array.isArray(d.items) ? d.items.length : 0;
}

module.exports = { getArgusData, getDecisionCount, openSource };

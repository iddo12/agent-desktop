// v1.63.4: the agent message channel ("uds:<socket>" in SendMessage terms). Address resolution
// follows shared_tools\find_agent.py: every live session writes ~/.claude/sessions/<pid>.json with
// its cwd and messagingSocketPath; Agent Desktop runs each agent in <agent folder>\.claude-session.
// Only cwd/pid/messagingSocketPath/updatedAt are read from those files - never the sibling *.key files.
const fs = require("fs");
const path = require("path");
const os = require("os");

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

function norm(p) { return path.resolve(p).replace(/[\/]+$/, "").toLowerCase(); }

function resolveAddress(agentPath, sessionsDir) {
  const dir = sessionsDir || path.join(os.homedir(), ".claude", "sessions");
  const want = norm(agentPath);
  let best = null;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")); } catch (e) { continue; }
    if (!d || !d.cwd || !d.messagingSocketPath) continue;
    let c = norm(d.cwd);
    if (path.basename(c) === ".claude-session") c = path.dirname(c);
    if (c !== want) continue;
    if (!pidAlive(d.pid)) continue;
    const upd = d.updatedAt || d.startedAt || 0;
    if (!best || upd > best.updatedAt) best = { socketPath: d.messagingSocketPath, pid: d.pid, updatedAt: upd };
  }
  return best;
}

// The wire protocol for delivering a message over the socket is owned by Claude Code and is
// authenticated (per-session peer token). It is intentionally NOT reimplemented here from guesswork:
// a transport is injected with setTransport(fn(socketPath, text) -> Promise<{ok, reason?}>).
// Until one is registered, send() reports unavailable and callers fall back to pty typing.
let transport = null;
function setTransport(fn) { transport = typeof fn === "function" ? fn : null; }

async function send(agentPath, text, sessionsDir) {
  const addr = resolveAddress(agentPath, sessionsDir);
  if (!addr) return { ok: false, reason: "no live session address" };
  if (!transport) return { ok: false, reason: "no channel transport registered" };
  try {
    const r = await transport(addr.socketPath, text);
    return r && r.ok ? { ok: true } : { ok: false, reason: (r && r.reason) || "transport rejected" };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

module.exports = { resolveAddress, setTransport, send };

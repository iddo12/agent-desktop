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
// v1.63.5: the default transport is a file drop. It never talks to the pipe; it writes one JSON
// request per file into the relay directory, and a separate Claude session (the "relay") delivers it
// with SendMessage and moves it to done/ or failed/ (siblings of requests/). Delivery is still judged by the
// marker-in-transcript check in handoffDelivery.js, so {ok:true, queued:true} only means "written".
const HEARTBEAT_MAX_AGE_MS = 60 * 1000; // the relay touches <relayDir>/../relay-alive every ~20 s
function userDataDir() {
  try { return require("electron").app.getPath("userData"); } catch (e) { return path.join(os.tmpdir(), "agent-desktop"); }
}
function relayDir() {
  return process.env.AGENT_DESKTOP_RELAY_DIR || path.join(userDataDir(), "handoff_relay", "requests");
}
function heartbeatPath() { return path.join(relayDir(), "..", "relay-alive"); }
function relayAlive() {
  try { return Date.now() - fs.statSync(heartbeatPath()).mtimeMs < HEARTBEAT_MAX_AGE_MS; } catch (e) { return false; }
}

let seq = 0;
function fileDropTransport(socketPath, text, meta) {
  // No fresh heartbeat = nobody is delivering these files: report unavailable so the caller types into the pty.
  if (!relayAlive()) return { ok: false, reason: "no relay" };
  const dir = relayDir();
  fs.mkdirSync(dir, { recursive: true });
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const ttlSec = (meta && meta.ttlSec) || 120;
  const id = createdAt.replace(/[-:.TZ]/g, "") + "-" + process.pid + "-" + (++seq) + "-" + Math.random().toString(36).slice(2, 8);
  const agent = (meta && meta.agent) || "";
  const req = { id, agent, to: "uds:" + socketPath, text: String(text), createdAt, ttlSec, expiresAt: new Date(nowMs + ttlSec * 1000).toISOString() };
  const tmp = path.join(dir, "." + id + ".tmp");   // not *.json, so the reader never sees a partial file
  fs.writeFileSync(tmp, JSON.stringify(req), "utf-8");
  fs.renameSync(tmp, path.join(dir, id + ".json"));
  return { ok: true, queued: true, id };
}

let transport = fileDropTransport;
function setTransport(fn) { transport = typeof fn === "function" ? fn : null; }

async function send(agentPath, text, sessionsDir, opts) {
  const addr = resolveAddress(agentPath, sessionsDir);
  if (!addr) return { ok: false, reason: "no live session address" };
  if (!transport) return { ok: false, reason: "no channel transport registered" };
  try {
    const r = await transport(addr.socketPath, text, { agent: path.basename(path.resolve(agentPath)), ttlSec: (opts && opts.ttlSec) || 120 });
    return r && r.ok ? { ok: true, queued: !!r.queued } : { ok: false, reason: (r && r.reason) || "transport rejected" };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

module.exports = { resolveAddress, setTransport, send, fileDropTransport, relayDir, heartbeatPath, relayAlive };

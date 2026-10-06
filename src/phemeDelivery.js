// v1.77.4 PHEME delivery - a small local command so the Stream Deck dictation tool (Tools\Pheme\pheme.py) can hand a
// message to the agent that is open in Agent Desktop WITHOUT clicking at a guessed screen position.
//
//   { cmd: "selected-agent" }                       -> { ok, agent }            which agent a dictation would go to
//   { cmd: "send-to-selected", text, source }       -> { ok, agent, verified, queued?, written } | { ok:false, reason }
//   { cmd: "ping" }                                 -> { ok:true }
// Every request carries { token } (random, in <userData>\pheme\local-token, readable only by this Windows user).
//
// This file is pure logic (all I/O injected) plus the named-pipe server, so it is unit-testable without Electron.
// The delivery itself is done by the renderer through the SAME path as the Send button (sendOrHold -> submitToAgent:
// bracketed paste, Enter, the 500-char file hand-off, the busy-agent queue); main then verifies it landed.
const net = require("net");
const crypto = require("crypto");

const MAX_TEXT = 20000;           // characters; longer is refused, never truncated
const MAX_REQUEST_BYTES = 96 * 1024;
const DEFAULTS = { verifyMs: 15000, pollMs: 1000 };

function tokenOk(given, want) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(want || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// deps: askRenderer(kind, payload) -> Promise<object>     kind "selected" | "send"
//       ptyState(agentPath) -> "attached" | "starting" | "none"
//       transcriptHas(agentPath, text, sinceMs) -> true | false | null (null = cannot tell)
//       sentLogSince(agentPath, sinceMs) -> boolean        main wrote this agent's pty after sinceMs (sent-messages.jsonl)
//       sleep(ms), now(), log(line)
function createHandler(deps, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  let chain = Promise.resolve(); // one dictation at a time: two quick taps must not overlap

  async function ask(kind, payload) {
    try { return (await deps.askRenderer(kind, payload)) || { ok: false, reason: "renderer-empty-reply" }; }
    catch (e) { return { ok: false, reason: "renderer-unreachable: " + ((e && e.message) || e) }; }
  }

  async function selectedAgent() {
    const r = await ask("selected", {});
    if (!r.ok) return { ok: false, reason: r.reason || "no-agent-selected" };
    const st = deps.ptyState(r.agentPath);
    if (st !== "attached") return { ok: false, reason: st === "starting" ? "pty-starting" : "pty-not-attached", agent: r.name };
    return { ok: true, agent: r.name, agentPath: r.agentPath };
  }

  async function sendToSelected(req) {
    const text = req.text;
    if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "empty-text" };
    if (text.length > MAX_TEXT) return { ok: false, reason: "text-too-long (" + text.length + " > " + MAX_TEXT + ")" };
    const source = String(req.source || "unknown").replace(/[^\w.-]/g, "").slice(0, 24) || "unknown";
    const sel = await selectedAgent();
    if (!sel.ok) { log(`pheme-delivery: refused (${sel.reason}) source=${source}`); return sel; }
    const t0 = now();
    const r = await ask("send", { text, expectPath: sel.agentPath, source });
    if (!r.ok) { log(`pheme-delivery: renderer refused (${r.reason}) agent=${sel.agent}`); return { ok: false, reason: r.reason || "send-failed", agent: sel.agent }; }
    if (r.how === "held") {
      log(`pheme-delivery: queued in the app for ${sel.agent} (agent busy / not ready), len=${text.length}`);
      return { ok: true, agent: sel.agent, queued: true, verified: false, written: false };
    }
    // sent (or sent mid-turn): prove it. written = main wrote the pty; verified = the transcript has it.
    const sentText = r.sentText || text;
    const end = t0 + o.verifyMs;
    let written = false, verified = false;
    for (;;) {
      try { written = written || !!deps.sentLogSince(sel.agentPath, t0); } catch (e) {}
      let has = null;
      try { has = await deps.transcriptHas(sel.agentPath, sentText, t0); } catch (e) {}
      if (has === true) { verified = true; break; }
      if (now() >= end) break;
      await sleep(Math.min(o.pollMs, Math.max(1, end - now())));
    }
    try { written = written || !!deps.sentLogSince(sel.agentPath, t0); } catch (e) {}
    if (!verified && !written) {
      log(`pheme-delivery: NOT written to ${sel.agent}'s terminal (${r.how}), len=${text.length}`);
      return { ok: false, reason: "not-written", agent: sel.agent };
    }
    log(`pheme-delivery: ${verified ? "VERIFIED in transcript" : "written, transcript not confirmed yet"} agent=${sel.agent} how=${r.how} len=${text.length} source=${source}`);
    return { ok: true, agent: sel.agent, verified, written, how: r.how };
  }

  return async function handle(req) {
    if (!req || typeof req !== "object") return { ok: false, reason: "bad-request" };
    if (req.cmd === "ping") return { ok: true };
    if (req.cmd === "selected-agent") {
      const s = await selectedAgent();
      return s.ok ? { ok: true, agent: s.agent } : { ok: false, reason: s.reason, agent: s.agent };
    }
    if (req.cmd === "send-to-selected") {
      const run = chain.then(() => sendToSelected(req));
      chain = run.catch(() => {});
      try { return await run; } catch (e) { return { ok: false, reason: "error: " + ((e && e.message) || e) }; }
    }
    return { ok: false, reason: "unknown-cmd" };
  };
}

// Named-pipe server: one JSON line in, one JSON line out, token checked first. The pipe name is random per start (a fixed
// name could be grabbed first by another process that the client would then hand the token to) and is published in the
// pipe-name file next to the token file.
function startServer({ pipeName, token, handle, log, onListening }) {
  const say = log || (() => {});
  const server = net.createServer((sock) => {
    let buf = "";
    let handled = false;
    sock.setTimeout(90000, () => sock.destroy());
    sock.on("error", () => {});
    sock.on("data", async (d) => {
      if (handled) return;
      buf += d.toString("utf8");
      if (buf.length > MAX_REQUEST_BYTES) { handled = true; return sock.destroy(); }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch (e) { return sock.destroy(); }
      if (!tokenOk(req && req.token, token)) return sock.end(JSON.stringify({ ok: false, reason: "bad-token" }) + "\n");
      let res;
      try { res = await handle(req); } catch (e) { res = { ok: false, reason: "error: " + ((e && e.message) || e) }; }
      try { sock.end(JSON.stringify(res) + "\n"); } catch (e) {}
    });
  });
  server.on("error", (e) => say(`pheme pipe error: ${e.message}`));
  server.listen(pipeName, () => { say(`pheme local pipe ${pipeName}`); if (onListening) onListening(); });
  return server;
}

module.exports = { createHandler, startServer, tokenOk, MAX_TEXT, DEFAULTS };

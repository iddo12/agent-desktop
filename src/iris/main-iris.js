// IRIS - main-process wiring (v1.55.0). Loaded from main.js inside try/catch
// like guards-main.js, so a fault here can only disable IRIS, never the app.
//
//   - one IrisService with its data in <userData>\iris (the sandbox has its own
//     userData, so it never sees the live keys; it also uses a different port
//     and pipe name so both instances can run side by side)
//   - iris-* IPC for the Links view (renderer/iris.js)
//   - a local named pipe so the COO (or any tool on this PC) can send through
//     tools/iris.js - guarded by a random token file only this user can read
//   - incoming messages are written to <userData>\iris\inbox\*.md and queued
//     for delivery to the COO agent; the renderer does the actual hand-over
//     because only it knows which agent chats are live.
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { IrisService, DEFAULT_PORT } = require("./service");

function init({ ipcMain, app, safeStorage, Notification, getMainWindow, log, testMode }) {
  const say = typeof log === "function" ? log : () => {};
  const dir = path.join(app.getPath("userData"), "iris");
  fs.mkdirSync(dir, { recursive: true });
  const isTest = !!testMode;
  // Random per start and published in the token file (security review
  // 2026-09-25): a fixed, guessable pipe name could be taken first by another
  // process, which tools/iris.js would then hand the token and message to.
  const pipeName = `\\\\.\\pipe\\agent-desktop-iris${isTest ? "-test" : ""}-${crypto.randomBytes(8).toString("hex")}`;
  const toolPath = path.join(__dirname, "..", "..", "tools", "iris.js");

  const canProtect = !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  const protect = (s) => (canProtect ? { dpapi: safeStorage.encryptString(s).toString("base64") } : { plain: s });
  const unprotect = (o) => (o.dpapi ? safeStorage.decryptString(Buffer.from(o.dpapi, "base64")) : o.plain);

  // Pending deliveries to the COO survive a restart.
  const pendingFile = path.join(dir, "pending-deliveries.json");
  let pending = [];
  try { pending = JSON.parse(fs.readFileSync(pendingFile, "utf8")); } catch (e) {}
  const savePending = () => { try { fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2)); } catch (e) {} };

  const push = (channel, payload) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  const svc = new IrisService({
    dir,
    // Not the hostname: the name travels in the clear during pairing.
    name: isTest ? "Sandbox Agent Desktop" : "Agent Desktop",
    port: undefined,
    // The sandbox stays on loopback: no firewall prompt, nothing reachable from the LAN.
    bindHost: process.env.IRIS_BIND_HOST || (isTest ? "127.0.0.1" : "0.0.0.0"),
    protect,
    unprotect,
    log: (l) => say(l),
    deliver: (peer, env, framed, inboxFile) => {
      pending.push({ id: env.id, peer: peer.name, peerId: peer.id, type: env.type, inboxFile, at: new Date().toISOString() });
      savePending();
      push("iris-incoming", { count: pending.length });
      try {
        if (Notification && Notification.isSupported()) {
          new Notification({ title: `IRIS: message from ${peer.name}`, body: env.text.slice(0, 140) }).show();
        }
      } catch (e) {}
    },
  });
  if (!fs.existsSync(path.join(dir, "state.json"))) {
    svc.state.port = DEFAULT_PORT + (isTest ? 1 : 0);
    svc._save();
  }
  if (!canProtect) say("iris: safeStorage unavailable - keys stored unencrypted in userData");

  svc.onChange((what) => {
    push("iris-changed", {});
    if (what === "pending-sends") {
      try {
        const n = svc.status().pendingSends.length;
        if (n && Notification && Notification.isSupported()) {
          new Notification({ title: "IRIS: a reply needs your approval", body: `${n} reply${n === 1 ? "" : "ies"} waiting in the Links tab before ${n === 1 ? "it" : "they"} can send.` }).show();
        }
      } catch (e) {}
    }
  });
  if (svc.state.enabled) svc.start().catch((e) => {
    say(`iris start failed: ${e.message}`);
    // 2026-10-06: a second instance that cannot take the port must not leave ITS pipe name behind (tools/iris.js then talked to a dead pipe)
    if (/EADDRINUSE/.test(String(e && e.message)) && prevPipeName) { try { fs.writeFileSync(path.join(dir, "pipe-name"), prevPipeName, "utf8"); } catch (e2) {} }
  });

  const h = (name, fn) => ipcMain.handle(name, async (event, arg) => {
    try { return await fn(arg || {}); } catch (e) { say(`${name} failed: ${e.message}`); return { ok: false, reason: e.message }; }
  });
  h("iris-status", () => Object.assign(svc.status(), { pendingDeliveries: pending.length, test: isTest, toolCommand: `node "${toolPath}"${isTest ? " --test" : ""}` }));
  h("iris-set-enabled", ({ on }) => svc.setEnabled(on));
  h("iris-set-name", ({ name }) => svc.setMyName(name));
  h("iris-create-invite", () => svc.createInvite());
  h("iris-cancel-invite", () => svc.cancelInvite());
  h("iris-join", ({ invite }) => svc.join(invite));
  h("iris-set-peer", ({ peerId, patch }) => svc.setPeer(peerId, patch || {}));
  h("iris-unpair", ({ peerId }) => svc.unpair(peerId));
  h("iris-send", ({ peerId, text, type, replyTo }) => svc.send({ peerId, text, type, replyTo, fromAgent: "user (Links tab)" }));
  h("iris-approve-send", ({ id }) => svc.approveSend(id));
  h("iris-reject-send", ({ id }) => svc.rejectSend(id));
  h("iris-log", ({ limit }) => svc.readLog(limit || 200));
  h("iris-pending", () => pending.map((p) => {
    let text = "";
    try { text = fs.readFileSync(p.inboxFile, "utf8"); } catch (e) {}
    return Object.assign({}, p, { text });
  }));
  // Copy the framed message into the receiving agent's own session folder, which
  // its CLI can always read. userData can be invisible to it: when Agent Desktop
  // is started from inside an MSIX-packaged app (e.g. Claude Desktop), %APPDATA%
  // writes are redirected into that package's private folder - found in the
  // sandbox test, where the COO's Read tool said the inbox file didn't exist.
  h("iris-prepare-delivery", ({ id, agentPath }) => {
    const item = pending.find((p) => p.id === id);
    if (!item) return { ok: false, reason: "unknown-id" };
    // Only a real agent folder from the app's own agent list (security review
    // 2026-09-25: the path comes from the renderer, so never trust it as given).
    let known = [];
    try { known = require("../agents").listAgents().map((a) => path.resolve(a.path).toLowerCase()); } catch (e) {}
    if (!agentPath || !known.includes(path.resolve(String(agentPath)).toLowerCase())) return { ok: false, reason: "not-an-agent" };
    const sessionDir = path.join(String(agentPath), ".claude-session");
    if (!fs.existsSync(sessionDir)) return { ok: false, reason: "no-session-folder" };
    const outDir = path.join(sessionDir, "iris-inbox");
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, path.basename(item.inboxFile));
    fs.writeFileSync(out, fs.readFileSync(item.inboxFile, "utf8"), "utf8");
    return { ok: true, file: out };
  });
  h("iris-delivered", ({ id, to }) => {
    const item = pending.find((p) => p.id === id);
    pending = pending.filter((p) => p.id !== id);
    savePending();
    if (item) svc._audit({ event: "handed-to-agent", id, peer: item.peerId, agent: to || null });
    push("iris-incoming", { count: pending.length });
    return { ok: true };
  });

  // ---------------- local pipe for tools/iris.js ----------------
  const tokenFile = path.join(dir, "local-token");
  let token;
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch (e) {}
  if (!token || token.length < 32) {
    token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
  }
  let prevPipeName = null;
  try { prevPipeName = fs.readFileSync(path.join(dir, "pipe-name"), "utf8"); } catch (e) {}
  fs.writeFileSync(path.join(dir, "pipe-name"), pipeName, "utf8");
  const pipe = net.createServer((sock) => {
    let buf = "";
    let handled = false; // one command per connection
    sock.setTimeout(15000, () => sock.destroy());
    sock.on("error", () => {});
    sock.on("data", async (d) => {
      if (handled) return;
      buf += d.toString("utf8");
      if (buf.length > 64 * 1024) return sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch (e) { return sock.destroy(); }
      const tok = Buffer.from(String(req.token || ""));
      const want = Buffer.from(token);
      if (tok.length !== want.length || !crypto.timingSafeEqual(tok, want)) return sock.end(JSON.stringify({ ok: false, reason: "bad-token" }) + "\n");
      let res;
      try {
        if (req.cmd === "send") {
          // viaAgent is hard-coded true here, never read from req - the pipe is
          // the agent/CLI path, so every send through it must hold for human
          // approval regardless of whether the agent bothered to set replyTo
          // (security review 2026-10-02, follow-up on finding 1).
          res = svc.send({ peerId: req.to, text: req.text, type: req.type || "info", replyTo: req.replyTo || null, fromAgent: req.fromAgent || "local tool", viaAgent: true });
          if (res.ok) await svc.flushOutbox();
          const item = svc.outbox.find((o) => o.env.id === res.id);
          if (item) res.status = item.status;
        } else if (req.cmd === "peers") {
          res = { ok: true, enabled: svc.state.enabled, peers: svc.status().peers.map((p) => ({ id: p.id, name: p.name, paused: p.paused, lastSeen: p.lastSeen })) };
        } else if (req.cmd === "status") {
          res = Object.assign({ ok: true }, svc.status());
        } else {
          res = { ok: false, reason: "unknown-cmd" };
        }
      } catch (e) {
        res = { ok: false, reason: e.message };
      }
      sock.end(JSON.stringify(res) + "\n");
    });
  });
  pipe.on("error", (e) => say(`iris pipe error: ${e.message}`));
  pipe.listen(pipeName, () => say(`iris local pipe ${pipeName}`));

  app.on("before-quit", () => { try { pipe.close(); } catch (e) {} svc.stop().catch(() => {}); });
  return svc;
}

module.exports = { init };

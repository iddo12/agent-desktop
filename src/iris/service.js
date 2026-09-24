// IRIS service - one per Agent Desktop install. Owns the keys, the peer list,
// the LAN listener, pairing, the outbox/retry queue and the audit log.
// Plain Node (no Electron imports) so tests can run two services side by side;
// main-iris.js wires it into the app.
//
// Wire format: one JSON line per TCP connection, one JSON line back, close.
//   pairing : {kind:"pair-hello"}  -> {kind:"pair-welcome"} | {kind:"pair-error"}
//   message : sealed frame {v,from,to,n,c}  -> sealed ack frame | nothing
// A connection that isn't a valid frame from a paired peer gets closed with
// no information back.
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const ic = require("./crypto");
const gw = require("./gateway");

const DEFAULT_PORT = 47321;
const INVITE_TTL_MS = 10 * 60 * 1000;
const INVITE_MAX_TRIES = 5;
const MAX_LINE = 256 * 1024;
const IO_TIMEOUT_MS = 10000;
const RETRY_MS = 60 * 1000;
const CONN_PER_MIN_PER_IP = 60;

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

// Send one line, read one line back.
function exchange(host, port, obj) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = "";
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    sock.setTimeout(IO_TIMEOUT_MS, () => finish(new Error("timeout")));
    sock.on("error", (e) => finish(e));
    sock.on("connect", () => sock.write(JSON.stringify(obj) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > MAX_LINE) return finish(new Error("reply-too-large"));
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try { finish(null, JSON.parse(buf.slice(0, nl))); } catch (e) { finish(new Error("bad-reply")); }
      }
    });
    sock.on("end", () => finish(new Error("closed-without-reply")));
  });
}

// Peer names are chosen by the other side and later shown to our COO inside
// the fixed frame - keep them to plain, short, single-line text.
function cleanName(n) {
  return String(n || "Agent Desktop").replace(/[\r\n\t"`<>\[\]{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Agent Desktop";
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  // Home networks are almost always 10.x or 192.168.x. 172.16-31.x is mostly
  // Hyper-V / WSL / Docker virtual adapters on Windows, which the other PC
  // can't reach - only fall back to those when there is nothing else.
  const home = out.filter((ip) => /^(10\.|192\.168\.)/.test(ip));
  return home.length ? home : out;
}

class IrisService {
  // opts: { dir, name, port, bindHost, protect, unprotect, deliver(peer, env, framed), log(line), now() }
  constructor(opts) {
    this.dir = opts.dir;
    this.opts = opts;
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.now = opts.now || (() => Date.now());
    this.protect = opts.protect || ((s) => ({ plain: s }));
    this.unprotect = opts.unprotect || ((o) => o.plain);
    this.server = null;
    this.invite = null;
    this.connLog = new Map();
    this.retryTimer = null;
    this.listeners = new Set();
    fs.mkdirSync(path.join(this.dir, "log"), { recursive: true });
    fs.mkdirSync(path.join(this.dir, "inbox"), { recursive: true });
    this._loadIdentity();
    this.peers = readJson(this._p("peers.json"), {});
    this.state = Object.assign({ enabled: false, port: opts.port || DEFAULT_PORT, seen: {}, counts: {} }, readJson(this._p("state.json"), {}));
    if (opts.port) this.state.port = opts.port;
    this.outbox = readJson(this._p("outbox.json"), []);
  }

  _p(f) { return path.join(this.dir, f); }

  _loadIdentity() {
    const f = this._p("identity.json");
    const stored = readJson(f, null);
    if (stored && stored.secret) {
      const sec = JSON.parse(this.unprotect(stored.secret));
      this.me = Object.assign({}, stored.public, sec);
      return;
    }
    this.me = ic.generateIdentity(this.opts.name);
    const pub = ic.publicPart(this.me);
    pub.created = this.me.created;
    const secret = this.protect(JSON.stringify({ signSk: this.me.signSk, boxSk: this.me.boxSk }));
    atomicWrite(f, JSON.stringify({ public: pub, secret }, null, 2));
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _changed(what) { for (const fn of this.listeners) { try { fn(what); } catch (e) {} } }

  _save() {
    atomicWrite(this._p("peers.json"), JSON.stringify(this.peers, null, 2));
    atomicWrite(this._p("state.json"), JSON.stringify(this.state));
    atomicWrite(this._p("outbox.json"), JSON.stringify(this.outbox, null, 2));
  }

  _audit(entry) {
    const e = Object.assign({ at: new Date(this.now()).toISOString() }, entry);
    const f = path.join(this.dir, "log", `${e.at.slice(0, 7)}.jsonl`);
    try { fs.appendFileSync(f, JSON.stringify(e) + "\n", "utf8"); } catch (err) { this.log(`iris audit write failed: ${err.message}`); }
    this._changed("log");
  }

  // Gateway state view: peers' pause/cap + enabled + seen/counts.
  _gwState() {
    const peers = {};
    for (const [id, p] of Object.entries(this.peers)) peers[id] = { paused: !!p.paused, dailyCap: p.dailyCap };
    return { enabled: this.state.enabled, peers, seen: this.state.seen, counts: this.state.counts };
  }

  // ---------- status / settings ----------
  status() {
    return {
      enabled: this.state.enabled,
      listening: !!this.server,
      port: this.state.port,
      me: { id: this.me.id, name: this.me.name },
      addresses: lanAddresses(),
      invite: this.invite && this.invite.expiresAt > this.now()
        ? { code: this.invite.code, expiresAt: this.invite.expiresAt, strings: this.invite.strings } : null,
      peers: Object.values(this.peers).map((p) => ({
        id: p.id, name: p.name, addr: p.addr, trust: p.trust, paused: !!p.paused,
        pairedAt: p.pairedAt, fingerprint: ic.fingerprint(this.me, p), lastSeen: p.lastSeen || null,
      })),
      outbox: this.outbox.map((o) => ({ id: o.env.id, peer: o.peerId, status: o.status, tries: o.tries, lastError: o.lastError || null })),
    };
  }

  async setEnabled(on) {
    this.state.enabled = !!on;
    this._save();
    this._audit({ event: on ? "iris-on" : "iris-off" });
    if (on) await this.start(); else await this.stop();
    return this.status();
  }

  setMyName(name) {
    const n = String(name || "").trim() ? cleanName(name) : "";
    if (!n) return this.status();
    this.me.name = n;
    const f = this._p("identity.json");
    const stored = readJson(f, null);
    if (stored) { stored.public.name = n; atomicWrite(f, JSON.stringify(stored, null, 2)); }
    return this.status();
  }

  setPeer(peerId, patch) {
    const p = this.peers[peerId];
    if (!p) return { ok: false, reason: "unknown-peer" };
    if ("paused" in patch) p.paused = !!patch.paused;
    if ("name" in patch && String(patch.name).trim()) p.name = cleanName(patch.name);
    if ("dailyCap" in patch && Number.isInteger(patch.dailyCap) && patch.dailyCap >= 0 && patch.dailyCap <= 1000) p.dailyCap = patch.dailyCap;
    // trust is recorded now; Tier 1 (charters) only exists from Stage 2.
    if ("trust" in patch && ["household", "remote"].includes(patch.trust)) p.trust = patch.trust;
    this._save();
    this._audit({ event: "peer-updated", peer: peerId, patch });
    return { ok: true };
  }

  unpair(peerId) {
    const p = this.peers[peerId];
    if (!p) return { ok: false, reason: "unknown-peer" };
    delete this.peers[peerId];
    this.outbox = this.outbox.filter((o) => o.peerId !== peerId);
    this._save();
    this._audit({ event: "unpaired", peer: peerId, name: p.name });
    return { ok: true };
  }

  // ---------- listener ----------
  async start() {
    if (this.server || !this.state.enabled) return;
    const host = this.opts.bindHost || "0.0.0.0";
    await new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this._onConnection(sock));
      srv.maxConnections = 32;
      srv.once("error", reject);
      srv.listen(this.state.port, host, () => { srv.removeListener("error", reject); this.server = srv; resolve(); });
    });
    this.log(`iris listening on ${host}:${this.state.port}`);
    this.retryTimer = setInterval(() => this.flushOutbox().catch(() => {}), RETRY_MS);
    this.flushOutbox().catch(() => {});
    this._changed("status");
  }

  async stop() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    this.invite = null;
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((r) => s.close(() => r()));
    }
    this._changed("status");
  }

  _rateLimited(ip) {
    const t = this.now();
    const arr = (this.connLog.get(ip) || []).filter((x) => t - x < 60000);
    arr.push(t);
    this.connLog.set(ip, arr);
    return arr.length > CONN_PER_MIN_PER_IP;
  }

  _onConnection(sock) {
    const ip = (sock.remoteAddress || "").replace(/^::ffff:/, "");
    if (this._rateLimited(ip)) return sock.destroy();
    let buf = "";
    let handled = false;
    sock.setTimeout(IO_TIMEOUT_MS, () => sock.destroy());
    sock.on("error", () => {});
    sock.on("data", (d) => {
      if (handled) return;
      buf += d.toString("utf8");
      if (buf.length > MAX_LINE) return sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      let obj;
      try { obj = JSON.parse(buf.slice(0, nl)); } catch (e) { return sock.destroy(); }
      Promise.resolve(this._handle(obj, ip))
        .then((reply) => { if (reply) sock.end(JSON.stringify(reply) + "\n"); else sock.destroy(); })
        .catch((e) => { this.log(`iris handler error: ${e.message}`); sock.destroy(); });
    });
  }

  async _handle(obj, ip) {
    if (obj && obj.kind === "pair-hello") return this._onPairHello(obj, ip);
    if (obj && obj.v === 1) return this._onFrame(obj, ip);
    return null;
  }

  // ---------- pairing ----------
  createInvite() {
    if (!this.state.enabled || !this.server) return { ok: false, reason: "iris-off" };
    const code = ic.newInviteCode();
    const addrs = this.opts.bindHost === "127.0.0.1" ? ["127.0.0.1"] : lanAddresses();
    const strings = addrs.map((a) => `IRIS1:${a}:${this.state.port}:${code}`);
    this.invite = { code, expiresAt: this.now() + INVITE_TTL_MS, tries: 0, strings };
    this._audit({ event: "invite-created", expiresAt: new Date(this.invite.expiresAt).toISOString() });
    this._changed("status");
    return { ok: true, code, strings, expiresAt: this.invite.expiresAt };
  }

  cancelInvite() { this.invite = null; this._changed("status"); return { ok: true }; }

  _onPairHello(msg, ip) {
    const inv = this.invite;
    if (!inv || inv.expiresAt <= this.now()) return { kind: "pair-error", reason: "no-open-invite" };
    inv.tries += 1;
    if (inv.tries > INVITE_MAX_TRIES) { this.invite = null; this._changed("status"); return { kind: "pair-error", reason: "invite-closed" }; }
    const pub = msg.pub || {};
    if (typeof pub.signPk !== "string" || typeof pub.boxPk !== "string" || ic.peerIdFor(pub) !== pub.id) {
      return { kind: "pair-error", reason: "bad-keys" };
    }
    const expected = ic.pairingProof(inv.code, "join", pub, null);
    if (!ic.proofMatches(expected, msg.proof)) {
      this._audit({ event: "pair-rejected", ip, reason: "bad-proof" });
      return { kind: "pair-error", reason: "bad-proof" };
    }
    if (pub.id === this.me.id) return { kind: "pair-error", reason: "self" };
    const port = Number.isInteger(msg.port) ? msg.port : DEFAULT_PORT;
    const peer = {
      id: pub.id, name: cleanName(pub.name), signPk: pub.signPk, boxPk: pub.boxPk,
      addr: { host: ip, port }, trust: "remote", paused: false, pairedAt: new Date(this.now()).toISOString(),
    };
    this.peers[peer.id] = peer;
    this.invite = null; // one use
    this._save();
    this._audit({ event: "paired", peer: peer.id, name: peer.name, role: "inviter", ip });
    this._changed("status");
    const mine = ic.publicPart(this.me);
    return { kind: "pair-welcome", pub: mine, port: this.state.port, proof: ic.pairingProof(inv.code, "welcome", mine, pub) };
  }

  async join(inviteString) {
    if (!this.state.enabled || !this.server) return { ok: false, reason: "iris-off" };
    const m = /^IRIS1:([^:]+):(\d{1,5}):([0-9A-Za-z-]+)$/.exec(String(inviteString || "").trim());
    if (!m) return { ok: false, reason: "bad-invite-format" };
    const [, host, portStr, code] = m;
    const port = Number(portStr);
    const mine = ic.publicPart(this.me);
    let reply;
    try {
      reply = await exchange(host, port, { kind: "pair-hello", pub: mine, port: this.state.port, proof: ic.pairingProof(code, "join", mine, null) });
    } catch (e) {
      return { ok: false, reason: `unreachable: ${e.message}` };
    }
    if (!reply || reply.kind !== "pair-welcome") return { ok: false, reason: (reply && reply.reason) || "no-welcome" };
    const pub = reply.pub || {};
    if (typeof pub.signPk !== "string" || typeof pub.boxPk !== "string" || ic.peerIdFor(pub) !== pub.id) return { ok: false, reason: "bad-keys" };
    if (!ic.proofMatches(ic.pairingProof(code, "welcome", pub, mine), reply.proof)) {
      this._audit({ event: "pair-rejected", reason: "bad-welcome-proof", host });
      return { ok: false, reason: "bad-welcome-proof" };
    }
    const peer = {
      id: pub.id, name: cleanName(pub.name), signPk: pub.signPk, boxPk: pub.boxPk,
      addr: { host, port: Number.isInteger(reply.port) ? reply.port : port }, trust: "remote", paused: false,
      pairedAt: new Date(this.now()).toISOString(),
    };
    this.peers[peer.id] = peer;
    this._save();
    this._audit({ event: "paired", peer: peer.id, name: peer.name, role: "joiner", host });
    this._changed("status");
    return { ok: true, peer: { id: peer.id, name: peer.name }, fingerprint: ic.fingerprint(this.me, peer) };
  }

  // ---------- messages ----------
  send({ peerId, text, type = "info", replyTo = null, fromAgent = null, lifetimeMs }) {
    const peer = this.peers[peerId] || Object.values(this.peers).find((p) => p.name.toLowerCase() === String(peerId || "").toLowerCase());
    if (!peer) return { ok: false, reason: "unknown-peer" };
    if (!["info", "request", "reply"].includes(type)) return { ok: false, reason: "bad-type" };
    const chk = gw.checkOutbound(this._gwState(), peer.id, text, this.now());
    if (!chk.ok) {
      this._audit({ event: "send-blocked", peer: peer.id, reason: chk.reason });
      this._save();
      return chk;
    }
    const now = this.now();
    const life = Math.min(Number(lifetimeMs) || gw.LIMITS.defaultLifetimeMs, gw.LIMITS.maxLifetimeMs);
    const env = {
      id: crypto.randomBytes(12).toString("base64url"),
      type, text, hop: 0,
      sent: new Date(now).toISOString(),
      expires: new Date(now + life).toISOString(),
    };
    if (replyTo) env.replyTo = String(replyTo);
    if (fromAgent) env.fromAgent = String(fromAgent).slice(0, 80);
    const bad = gw.validateEnvelope(env);
    if (bad) return { ok: false, reason: bad };
    this.outbox.push({ peerId: peer.id, env, status: "pending", tries: 0 });
    this._save();
    this._audit({ event: "queued", dir: "out", peer: peer.id, id: env.id, type, text });
    this.flushOutbox().catch(() => {});
    return { ok: true, id: env.id, peer: peer.name };
  }

  // Callers always get a promise that settles after a pass which started
  // after their call - a flush already in flight is followed by one more.
  flushOutbox() {
    if (this._flushP) { this._again = true; return this._flushP; }
    this._flushP = (async () => {
      try {
        do { this._again = false; await this._flushOnce(); } while (this._again);
      } finally {
        this._flushP = null;
      }
    })();
    return this._flushP;
  }

  async _flushOnce() {
    if (!this.state.enabled) return;
    {
      for (const item of this.outbox) {
        if (item.status !== "pending") continue;
        const peer = this.peers[item.peerId];
        if (!peer || peer.paused) continue;
        if (Date.parse(item.env.expires) <= this.now()) {
          item.status = "expired";
          this._audit({ event: "expired", dir: "out", peer: item.peerId, id: item.env.id });
          continue;
        }
        item.tries += 1;
        try {
          const frame = ic.seal({ kind: "msg", port: this.state.port, env: item.env }, this.me, peer);
          const reply = await exchange(peer.addr.host, peer.addr.port, frame);
          const opened = ic.open(reply, this.me, (id) => (id === peer.id ? peer : null));
          if (!opened.ok || opened.payload.kind !== "ack" || opened.payload.id !== item.env.id) throw new Error(opened.reason || "bad-ack");
          item.status = opened.payload.ok ? "delivered" : "rejected";
          item.lastError = opened.payload.ok ? null : opened.payload.reason;
          peer.lastSeen = new Date(this.now()).toISOString();
          this._audit({ event: item.status, dir: "out", peer: item.peerId, id: item.env.id, reason: item.lastError || undefined });
        } catch (e) {
          item.lastError = e.message;
        }
      }
      // keep finished items for a day so the UI can show them, then drop
      const cutoff = this.now() - 24 * 60 * 60 * 1000;
      this.outbox = this.outbox.filter((o) => o.status === "pending" || Date.parse(o.env.sent) > cutoff);
      gw.pruneSeen(this.state, this.now());
      this._save();
      this._changed("outbox");
    }
  }

  async _onFrame(frame, ip) {
    const opened = ic.open(frame, this.me, (id) => this.peers[id] || null);
    if (!opened.ok) {
      this._audit({ event: "frame-dropped", ip, reason: opened.reason });
      return null; // tell a stranger nothing
    }
    const { peer, payload } = opened;
    if (!payload || payload.kind !== "msg" || !payload.env) return null;
    const env = payload.env;
    const res = gw.checkInbound(this._gwState(), peer.id, env, this.now());
    // Learn the peer's current address (DHCP may have moved it).
    if (Number.isInteger(payload.port) && ip) peer.addr = { host: ip, port: payload.port };
    peer.lastSeen = new Date(this.now()).toISOString();
    if (!res.ok) {
      this._audit({ event: "rejected", dir: "in", peer: peer.id, id: env && env.id, reason: res.reason });
      this._save();
      return ic.seal({ kind: "ack", id: env && env.id, ok: false, reason: res.reason }, this.me, peer);
    }
    const framed = gw.frameForCoo(peer, env, this.opts.sendHint);
    const inboxFile = path.join(this.dir, "inbox", `${env.sent.replace(/[:.]/g, "-")}_${env.id}.md`);
    try { fs.writeFileSync(inboxFile, framed, "utf8"); } catch (e) { this.log(`iris inbox write failed: ${e.message}`); }
    this._audit({ event: "received", dir: "in", peer: peer.id, id: env.id, type: env.type, text: env.text, inboxFile });
    this._save();
    try {
      if (typeof this.opts.deliver === "function") await this.opts.deliver(peer, env, framed, inboxFile);
    } catch (e) {
      this.log(`iris deliver failed: ${e.message}`);
    }
    return ic.seal({ kind: "ack", id: env.id, ok: true }, this.me, peer);
  }

  readLog(limit = 200) {
    const dir = path.join(this.dir, "log");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch (e) {}
    const out = [];
    for (let i = files.length - 1; i >= 0 && out.length < limit; i--) {
      const lines = fs.readFileSync(path.join(dir, files[i]), "utf8").trim().split("\n").reverse();
      for (const l of lines) {
        if (out.length >= limit) break;
        try { out.push(JSON.parse(l)); } catch (e) {}
      }
    }
    return out;
  }
}

module.exports = { IrisService, DEFAULT_PORT, exchange, lanAddresses };

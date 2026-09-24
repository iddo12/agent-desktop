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
//
// Security review 2026-09-25 (all fixed here): inbox file names no longer use
// any peer-supplied text; a peer's address is only learned from a message that
// passed every check; hard per-connection deadlines + per-IP concurrency cap
// (slow-trickle DoS); pairing errors are uniform and bad proofs lock out only
// the sending IP; proofs cover name and port; peers live in a prototype-less
// map; replies carry the hop count forward so two COOs can't ping-pong.
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const ic = require("./crypto");
const gw = require("./gateway");

const DEFAULT_PORT = 47321;
const INVITE_TTL_MS = 10 * 60 * 1000;
const INVITE_MAX_TRIES = 20;          // across all IPs, valid-looking hellos only
const INVITE_MAX_BAD_PER_IP = 3;
const MAX_LINE = 256 * 1024;
const DEADLINE_MS = 10000;            // hard, from connect - not an idle timeout
const RETRY_MS = 60 * 1000;
const CONN_PER_MIN_PER_IP = 60;
const CONN_CONCURRENT_PER_IP = 4;

const has = gw.has;

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function nullProto(obj) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(obj || {})) if (k !== "__proto__") out[k] = v;
  return out;
}

// Send one line, read one line back, all within DEADLINE_MS.
function exchange(host, port, obj) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = "";
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error("timeout")), DEADLINE_MS);
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
  return gw.stripInvisible(String(n || "Agent Desktop")).replace(/[\r\n\t"`<>\[\]{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Agent Desktop";
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
  // opts: { dir, name, port, bindHost, protect, unprotect, deliver(peer, env, framed, inboxFile), log(line), now(), sendHint }
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
    this.openConns = new Map();
    this.dropAudit = new Map();
    this.retryTimer = null;
    this.listeners = new Set();
    fs.mkdirSync(path.join(this.dir, "log"), { recursive: true });
    fs.mkdirSync(path.join(this.dir, "inbox"), { recursive: true });
    this._loadIdentity();
    this.peers = nullProto(readJson(this._p("peers.json"), {}));
    for (const [id, p] of Object.entries(this.peers)) if (!ic.validKeys(p) || p.id !== id) delete this.peers[id];
    this.state = Object.assign({ enabled: false, port: opts.port || DEFAULT_PORT, seen: {}, counts: {}, receivedHops: {} }, readJson(this._p("state.json"), {}));
    this.state.seen = nullProto(this.state.seen);
    this.state.counts = nullProto(this.state.counts);
    this.state.receivedHops = nullProto(this.state.receivedHops);
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

  // Noisy events from strangers are audited at most once a minute per IP+reason.
  _auditLimited(key, entry) {
    const t = this.now();
    const last = this.dropAudit.get(key) || 0;
    if (t - last < 60000) return;
    this.dropAudit.set(key, t);
    this._audit(entry);
  }

  // Gateway state view: peers' pause/caps + enabled + seen/counts.
  _gwState() {
    const peers = Object.create(null);
    for (const [id, p] of Object.entries(this.peers)) peers[id] = { paused: !!p.paused, dailyCap: p.dailyCap, dailyCharCap: p.dailyCharCap };
    return { enabled: this.state.enabled, peers, seen: this.state.seen, counts: this.state.counts };
  }

  _peer(id) { return has(this.peers, id) ? this.peers[id] : null; }

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
    const p = this._peer(peerId);
    if (!p) return { ok: false, reason: "unknown-peer" };
    patch = patch || {};
    if (has(patch, "paused")) p.paused = !!patch.paused;
    if (has(patch, "name") && String(patch.name).trim()) p.name = this._uniqueName(cleanName(patch.name), p.id);
    if (has(patch, "dailyCap") && Number.isInteger(patch.dailyCap) && patch.dailyCap >= 0 && patch.dailyCap <= 1000) p.dailyCap = patch.dailyCap;
    // trust is recorded now; Tier 1 (charters) only exists from Stage 2.
    if (has(patch, "trust") && ["household", "remote"].includes(patch.trust)) p.trust = patch.trust;
    this._save();
    this._audit({ event: "peer-updated", peer: peerId, patch: { paused: patch.paused, name: patch.name, dailyCap: patch.dailyCap, trust: patch.trust } });
    return { ok: true };
  }

  unpair(peerId) {
    const p = this._peer(peerId);
    if (!p) return { ok: false, reason: "unknown-peer" };
    delete this.peers[peerId];
    this.outbox = this.outbox.filter((o) => o.peerId !== peerId);
    this._save();
    this._audit({ event: "unpaired", peer: peerId, name: p.name });
    return { ok: true };
  }

  // Two peers must never share a display name - replies are addressed by id,
  // but people pick peers by name in the UI.
  _uniqueName(name, selfId) {
    const taken = new Set(Object.values(this.peers).filter((p) => p.id !== selfId).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 100; i++) {
      const n = `${name.slice(0, 55)} (${i})`;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return `${name.slice(0, 50)} ${crypto.randomBytes(3).toString("hex")}`;
  }

  // ---------- listener ----------
  async start() {
    if (this.server || !this.state.enabled) return;
    const host = this.opts.bindHost || "0.0.0.0";
    await new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this._onConnection(sock));
      srv.maxConnections = 64;
      srv.once("error", reject);
      srv.listen(this.state.port, host, () => { srv.removeListener("error", reject); this.server = srv; resolve(); });
    });
    this.log(`iris listening on ${host}:${this.state.port}`);
    this.retryTimer = setInterval(() => {
      this.flushOutbox().catch(() => {});
      this._pruneConnLog();
    }, RETRY_MS);
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

  _pruneConnLog() {
    const t = this.now();
    for (const [ip, arr] of this.connLog) {
      const keep = arr.filter((x) => t - x < 60000);
      if (keep.length) this.connLog.set(ip, keep); else this.connLog.delete(ip);
    }
    for (const [k, ts] of this.dropAudit) if (t - ts > 60000) this.dropAudit.delete(k);
  }

  _rateLimited(ip) {
    const t = this.now();
    const arr = (this.connLog.get(ip) || []).filter((x) => t - x < 60000);
    arr.push(t);
    this.connLog.set(ip, arr);
    return arr.length > CONN_PER_MIN_PER_IP || (this.openConns.get(ip) || 0) >= CONN_CONCURRENT_PER_IP;
  }

  _onConnection(sock) {
    const ip = (sock.remoteAddress || "").replace(/^::ffff:/, "");
    if (this._rateLimited(ip)) return sock.destroy();
    this.openConns.set(ip, (this.openConns.get(ip) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      const n = (this.openConns.get(ip) || 1) - 1;
      if (n > 0) this.openConns.set(ip, n); else this.openConns.delete(ip);
    };
    const deadline = setTimeout(() => sock.destroy(), DEADLINE_MS);
    sock.on("close", release);
    sock.on("error", () => {});
    let buf = "";
    let handled = false;
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
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (obj.kind === "pair-hello") return this._onPairHello(obj, ip);
    if (obj.v === 1) return this._onFrame(obj, ip);
    return null;
  }

  // ---------- pairing ----------
  createInvite() {
    if (!this.state.enabled || !this.server) return { ok: false, reason: "iris-off" };
    const code = ic.newInviteCode();
    const addrs = this.opts.bindHost === "127.0.0.1" ? ["127.0.0.1"] : lanAddresses();
    const strings = addrs.map((a) => `IRIS1:${a}:${this.state.port}:${code}`);
    this.invite = { code, expiresAt: this.now() + INVITE_TTL_MS, tries: 0, badByIp: new Map(), strings };
    this._audit({ event: "invite-created", expiresAt: new Date(this.invite.expiresAt).toISOString() });
    this._changed("status");
    return { ok: true, code, strings, expiresAt: this.invite.expiresAt };
  }

  cancelInvite() { this.invite = null; this._changed("status"); return { ok: true }; }

  _onPairHello(msg, ip) {
    // One reply for every failure: a stranger learns nothing about whether an
    // invite is open or why they were refused.
    const FAIL = { kind: "pair-error", reason: "pair-failed" };
    const inv = this.invite;
    if (!inv || inv.expiresAt <= this.now()) return FAIL;
    const pub = msg.pub && typeof msg.pub === "object" ? msg.pub : {};
    const port = Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536 ? msg.port : null;
    // Malformed hellos don't cost the invite anything.
    if (typeof pub.id !== "string" || typeof pub.signPk !== "string" || typeof pub.boxPk !== "string" ||
        typeof pub.name !== "string" || !port || !ic.validKeys(pub) || ic.peerIdFor(pub) !== pub.id || typeof msg.proof !== "string") {
      return FAIL;
    }
    if ((inv.badByIp.get(ip) || 0) >= INVITE_MAX_BAD_PER_IP) return FAIL;
    inv.tries += 1;
    if (inv.tries > INVITE_MAX_TRIES) { this.invite = null; this._changed("status"); return FAIL; }
    const joiner = { id: pub.id, signPk: pub.signPk, boxPk: pub.boxPk, name: pub.name, port };
    if (!ic.proofMatches(ic.pairingProof(inv.code, "join", joiner, null), msg.proof)) {
      inv.badByIp.set(ip, (inv.badByIp.get(ip) || 0) + 1);
      this._audit({ event: "pair-rejected", ip, reason: "bad-proof" });
      return FAIL;
    }
    if (pub.id === this.me.id) return FAIL;
    const peer = {
      id: pub.id, name: this._uniqueName(cleanName(pub.name), pub.id), signPk: pub.signPk, boxPk: pub.boxPk,
      addr: { host: ip, port }, trust: "remote", paused: false, pairedAt: new Date(this.now()).toISOString(),
    };
    this.peers[peer.id] = peer;
    this.invite = null; // one use
    this._save();
    this._audit({ event: "paired", peer: peer.id, name: peer.name, role: "inviter", ip });
    this._changed("status");
    const mine = Object.assign(ic.publicPart(this.me), { port: this.state.port });
    return { kind: "pair-welcome", pub: ic.publicPart(this.me), port: this.state.port, proof: ic.pairingProof(inv.code, "welcome", mine, joiner) };
  }

  async join(inviteString) {
    if (!this.state.enabled || !this.server) return { ok: false, reason: "iris-off" };
    const m = /^IRIS1:([^:]+):(\d{1,5}):([0-9A-Za-z-]+)$/.exec(String(inviteString || "").trim());
    if (!m) return { ok: false, reason: "bad-invite-format" };
    const [, host, portStr, code] = m;
    const port = Number(portStr);
    const mine = Object.assign(ic.publicPart(this.me), { port: this.state.port });
    let reply;
    try {
      reply = await exchange(host, port, { kind: "pair-hello", pub: ic.publicPart(this.me), port: this.state.port, proof: ic.pairingProof(code, "join", mine, null) });
    } catch (e) {
      return { ok: false, reason: `unreachable: ${e.message}` };
    }
    if (!reply || reply.kind !== "pair-welcome") return { ok: false, reason: "refused (wrong or expired invite, or the invite was already used)" };
    const pub = reply.pub && typeof reply.pub === "object" ? reply.pub : {};
    const rport = Number.isInteger(reply.port) && reply.port > 0 && reply.port < 65536 ? reply.port : null;
    if (typeof pub.name !== "string" || !rport || !ic.validKeys(pub) || ic.peerIdFor(pub) !== pub.id) return { ok: false, reason: "bad-keys" };
    const inviter = { id: pub.id, signPk: pub.signPk, boxPk: pub.boxPk, name: pub.name, port: rport };
    if (!ic.proofMatches(ic.pairingProof(code, "welcome", inviter, mine), reply.proof)) {
      this._audit({ event: "pair-rejected", reason: "bad-welcome-proof", host });
      return { ok: false, reason: "bad-welcome-proof" };
    }
    const peer = {
      id: pub.id, name: this._uniqueName(cleanName(pub.name), pub.id), signPk: pub.signPk, boxPk: pub.boxPk,
      addr: { host, port: rport }, trust: "remote", paused: false,
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
    const key = String(peerId || "");
    let peer = this._peer(key);
    if (!peer) {
      const byName = Object.values(this.peers).filter((p) => p.name.toLowerCase() === key.toLowerCase());
      if (byName.length > 1) return { ok: false, reason: "ambiguous-peer-name - use the peer id" };
      peer = byName[0] || null;
    }
    if (!peer) return { ok: false, reason: "unknown-peer" };
    if (!["info", "request", "reply"].includes(type)) return { ok: false, reason: "bad-type" };
    // A reply continues the chain it answers: hop = the received message's hop + 1.
    let hop = 0;
    if (replyTo) {
      const rk = `${peer.id}:${replyTo}`;
      if (has(this.state.receivedHops, rk)) hop = this.state.receivedHops[rk].hop + 1;
      if (hop >= gw.LIMITS.maxHop) {
        this._audit({ event: "send-blocked", peer: peer.id, reason: "hop-limit" });
        return { ok: false, reason: "hop-limit (this conversation has gone back and forth enough - ask your user)" };
      }
    }
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
      type, text, hop,
      sent: new Date(now).toISOString(),
      expires: new Date(now + life).toISOString(),
    };
    if (replyTo) env.replyTo = String(replyTo);
    if (fromAgent) env.fromAgent = String(fromAgent).slice(0, 80);
    const bad = gw.validateEnvelope(env);
    if (bad) return { ok: false, reason: bad };
    this.outbox.push({ peerId: peer.id, env, status: "pending", tries: 0 });
    this._save();
    this._audit({ event: "queued", dir: "out", peer: peer.id, id: env.id, type, hop, text });
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
    for (const item of this.outbox) {
      if (item.status !== "pending") continue;
      const peer = this._peer(item.peerId);
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
        if (!opened.ok || !opened.payload || opened.payload.kind !== "ack" || opened.payload.id !== item.env.id) throw new Error(opened.reason || "bad-ack");
        item.status = opened.payload.ok ? "delivered" : "rejected";
        item.lastError = opened.payload.ok ? null : String(opened.payload.reason || "").slice(0, 80);
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

  async _onFrame(frame, ip) {
    const opened = ic.open(frame, this.me, (id) => this._peer(id));
    if (!opened.ok) {
      this._auditLimited(`${ip}|${opened.reason}`, { event: "frame-dropped", ip, reason: opened.reason });
      return null; // tell a stranger nothing
    }
    const { peer, payload } = opened;
    if (!payload || typeof payload !== "object" || payload.kind !== "msg" || !payload.env) return null;
    const env = payload.env;
    const res = gw.checkInbound(this._gwState(), peer.id, env, this.now());
    if (!res.ok) {
      // No state change on a reject (a replayed frame must not be able to move
      // the peer's address, and needn't cost three file writes either).
      this._auditLimited(`${peer.id}|${res.reason}`, { event: "rejected", dir: "in", peer: peer.id, id: env && typeof env.id === "string" ? env.id.slice(0, 64) : null, reason: res.reason });
      return ic.seal({ kind: "ack", id: env && env.id, ok: false, reason: res.reason }, this.me, peer);
    }
    // Only a message that passed every check may teach us the peer's address.
    if (Number.isInteger(payload.port) && payload.port > 0 && payload.port < 65536 && ip) peer.addr = { host: ip, port: payload.port };
    peer.lastSeen = new Date(this.now()).toISOString();
    this.state.receivedHops[`${peer.id}:${env.id}`] = { hop: env.hop, at: this.now() };
    const framed = gw.frameForCoo(peer, env, this.opts.sendHint);
    // File name from OUR clock and the (pattern-checked) id - never peer text.
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const inboxFile = path.join(this.dir, "inbox", `${stamp}_${env.id}.md`);
    let written = false;
    try { fs.writeFileSync(inboxFile, framed, "utf8"); written = true; } catch (e) { this.log(`iris inbox write failed: ${e.message}`); }
    this._audit({ event: "received", dir: "in", peer: peer.id, id: env.id, type: env.type, hop: env.hop, text: env.text, inboxFile: written ? inboxFile : null });
    this._save();
    if (written) {
      try {
        if (typeof this.opts.deliver === "function") await this.opts.deliver(peer, env, framed, inboxFile);
      } catch (e) {
        this.log(`iris deliver failed: ${e.message}`);
      }
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

module.exports = { IrisService, DEFAULT_PORT, exchange, lanAddresses, cleanName };

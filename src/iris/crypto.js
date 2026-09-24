// IRIS crypto: identities, pairing proofs and sealed envelopes.
//
// No home-made primitives. Everything here is a thin wrapper around
// TweetNaCl (audited by Cure53, 2017) plus Node's built-in HMAC/SHA:
//   - identity   = an Ed25519 signing key pair + an X25519 box key pair
//   - seal/open  = sign the payload (Ed25519), then nacl.box it to the peer
//                  (X25519 + XSalsa20-Poly1305). box already proves the
//                  sender held its box secret key; the signature is kept so
//                  the audit log can show a message was really signed by
//                  that peer, independent of our own box key.
//   - pairing    = a one-time invite code of 80 random bits. Both sides prove
//                  they hold it with an HMAC over BOTH sides' public keys, so
//                  a man in the middle who swaps in his own keys can't produce
//                  a valid proof without the code, and 80 bits can't be brute
//                  forced offline within the code's 10-minute life. (A PAKE
//                  would allow shorter codes, but no audited JS SPAKE2/CPace
//                  exists - see Security\IRIS_AgentLink\IRIS_design_v2.md.)
const crypto = require("crypto");
const nacl = require("tweetnacl");

const b64 = (u8) => Buffer.from(u8).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ""), "base64"));

// Crockford base32, no I/L/O/U, so a code read aloud or retyped survives.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function generateIdentity(name) {
  const sign = nacl.sign.keyPair();
  const box = nacl.box.keyPair();
  const pub = { signPk: b64(sign.publicKey), boxPk: b64(box.publicKey) };
  return {
    id: peerIdFor(pub),
    name: String(name || "Agent Desktop"),
    signPk: pub.signPk,
    boxPk: pub.boxPk,
    signSk: b64(sign.secretKey),
    boxSk: b64(box.secretKey),
    created: new Date().toISOString(),
  };
}

// A peer's id is derived from its public keys, never from a user or host name,
// so it is stable per install and can't be claimed by anyone else.
function peerIdFor({ signPk, boxPk }) {
  const h = crypto.createHash("sha256").update(`${signPk}|${boxPk}`).digest();
  return base32(h.subarray(0, 10)); // 16 chars
}

function publicPart(identity) {
  return { id: identity.id, name: identity.name, signPk: identity.signPk, boxPk: identity.boxPk };
}

// Short number both users can compare on screen after pairing. Symmetric:
// both sides compute the same string whatever the order.
function fingerprint(a, b) {
  const parts = [`${a.signPk}|${a.boxPk}`, `${b.signPk}|${b.boxPk}`].sort();
  const h = crypto.createHash("sha256").update(parts.join("||")).digest();
  let digits = "";
  for (let i = 0; i < 6; i++) digits += String(h.readUInt16BE(i * 2) % 100000).padStart(5, "0");
  return digits.match(/.{5}/g).join(" ");
}

function newInviteCode() {
  const raw = base32(crypto.randomBytes(10)); // 80 bits -> 16 chars
  return raw.match(/.{4}/g).join("-");
}

function normalizeCode(code) {
  return String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1").replace(/O/g, "0");
}

function pairingProof(code, role, first, second) {
  const key = normalizeCode(code);
  const msg = `iris-pair-v1|${role}|${first.id}|${first.signPk}|${first.boxPk}|${second ? `${second.id}|${second.signPk}|${second.boxPk}` : "-"}`;
  return crypto.createHmac("sha256", key).update(msg).digest("base64");
}

function proofMatches(expected, given) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Seal a JSON payload from `me` (full identity) to `peer` (public part).
function seal(payload, me, peer) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = nacl.sign.detached(new Uint8Array(body), unb64(me.signSk));
  const plain = new Uint8Array(sig.length + body.length);
  plain.set(sig, 0);
  plain.set(body, sig.length);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(plain, nonce, unb64(peer.boxPk), unb64(me.boxSk));
  return { v: 1, from: me.id, to: peer.id, n: b64(nonce), c: b64(boxed) };
}

// Open a sealed frame. `lookupPeer(id)` returns the paired peer's public part
// or null. Returns { ok, peer, payload } or { ok:false, reason }.
function open(frame, me, lookupPeer) {
  if (!frame || frame.v !== 1 || typeof frame.from !== "string" || typeof frame.c !== "string" || typeof frame.n !== "string") {
    return { ok: false, reason: "malformed-frame" };
  }
  if (frame.to !== me.id) return { ok: false, reason: "not-for-us" };
  const peer = lookupPeer(frame.from);
  if (!peer) return { ok: false, reason: "unknown-peer" };
  const nonce = unb64(frame.n);
  if (nonce.length !== nacl.box.nonceLength) return { ok: false, reason: "malformed-frame" };
  const plain = nacl.box.open(unb64(frame.c), nonce, unb64(peer.boxPk), unb64(me.boxSk));
  if (!plain || plain.length < nacl.sign.signatureLength) return { ok: false, reason: "decrypt-failed" };
  const sig = plain.subarray(0, nacl.sign.signatureLength);
  const body = plain.subarray(nacl.sign.signatureLength);
  if (!nacl.sign.detached.verify(body, sig, unb64(peer.signPk))) return { ok: false, reason: "bad-signature" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (e) {
    return { ok: false, reason: "malformed-payload" };
  }
  return { ok: true, peer, payload };
}

module.exports = {
  generateIdentity,
  peerIdFor,
  publicPart,
  fingerprint,
  newInviteCode,
  normalizeCode,
  pairingProof,
  proofMatches,
  seal,
  open,
};

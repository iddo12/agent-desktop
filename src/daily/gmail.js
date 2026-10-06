// My Daily - Gmail (read-only). Google sign-in (OAuth 2.0 for installed apps, PKCE, loopback redirect) with the single scope
// gmail.readonly. Each PC signs in on its own; the refresh token is stored ONLY on that PC, encrypted with the OS (Electron
// safeStorage = Windows DPAPI), never in Dropbox, never sent to the renderer, never logged. The app only ever contacts
// accounts.google.com (in the person's own browser), oauth2.googleapis.com and gmail.googleapis.com over https.
// It produces the same shape as mailfeed.js (needAnswer / sentNoReply) so both sources can be merged and de-duplicated by Message-ID.
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { normId } = require("./mailfeed");

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const HOSTS = new Set(["oauth2.googleapis.com", "gmail.googleapis.com"]);
const DAY = 86400000;
const MAX_ACCOUNTS = 4;
const FRESH_MS = 5 * 60 * 1000;
const THREADS_PER_LIST = 60;
const CONCURRENCY = 4;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const NO_REPLY_FROM = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|newsletter|bounce)/i;

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// small https JSON helper, host allow-listed, size and time capped
function request(method, urlStr, { headers, body, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("bad url")); }
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) return reject(new Error("host not allowed"));
    const req = https.request(u, { method, headers: Object.assign({ Accept: "application/json" }, headers || {}), timeout: timeoutMs || 15000 }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 4 * 1024 * 1024) { req.destroy(new Error("response too large")); return; } chunks.push(c); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Google did not answer in time")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function headerOf(msg, name) {
  const hs = (msg && msg.payload && msg.payload.headers) || [];
  const h = hs.find((x) => x && String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value || "") : "";
}
const addrOf = (s) => { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim().toLowerCase(); };

// Pure: decide what a Gmail thread (metadata format) means for My Daily. `me` = the account's address.
// -> { kind: "needAnswer"|"sentNoReply"|null, ... }
function classifyThread(thread, me, now) {
  const msgs = (thread && thread.messages) || [];
  if (!msgs.length) return { kind: null };
  const last = msgs[msgs.length - 1];
  const fromRaw = headerOf(last, "From");
  const t = Number(last.internalDate) || Date.parse(headerOf(last, "Date"));
  if (!Number.isFinite(t)) return { kind: null };
  const mine = addrOf(fromRaw) === String(me).toLowerCase() || (last.labelIds || []).includes("SENT");
  const base = {
    id: normId(headerOf(last, "Message-ID") || headerOf(last, "Message-Id") || last.id),
    subject: clean(headerOf(last, "Subject"), 200) || "(no subject)",
    ageDays: Math.max(0, Math.floor((now - t) / DAY)),
  };
  if (mine) return Object.assign(base, { kind: "sentNoReply", to: clean(headerOf(last, "To"), 160) });
  if (NO_REPLY_FROM.test(fromRaw)) return { kind: null };
  const labels = last.labelIds || [];
  if (labels.some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l) || l === "SPAM" || l === "TRASH")) return { kind: null };
  return Object.assign(base, { kind: "needAnswer", from: clean(fromRaw, 160) });
}

function create({ dataDir, safeStorage, openExternal, client, log, request: req }) {
  const say = typeof log === "function" ? log : () => {};
  const call = req || request;
  const file = path.join(dataDir, "gmail-accounts.bin");
  const cache = new Map();   // email -> { at, items, error }
  let adding = null;

  const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; } };
  function readAccounts() {
    try {
      const raw = fs.readFileSync(file);
      const txt = canEncrypt() ? safeStorage.decryptString(raw) : "";
      const v = JSON.parse(txt);
      return (Array.isArray(v.accounts) ? v.accounts : []).filter((a) => a && typeof a.email === "string" && typeof a.refresh === "string").slice(0, MAX_ACCOUNTS);
    } catch (e) { return []; }
  }
  function writeAccounts(list) {
    if (!canEncrypt()) throw new Error("This PC cannot encrypt the Google sign-in, so it will not be stored.");
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    try { fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify({ accounts: list }))); fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* nothing */ } throw e; }
  }
  const configured = () => !!(client && client.clientId && client.clientSecret);

  async function accessToken(acct) {
    const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: acct.refresh, grant_type: "refresh_token" }).toString();
    const r = await call("POST", "https://oauth2.googleapis.com/token", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (r.status !== 200 || !r.json || !r.json.access_token) {
      const code = r.json && r.json.error;
      throw new Error(code === "invalid_grant" ? "Google sign-in expired or was revoked: add the account again" : "Google refused the sign-in (" + (code || r.status) + ")");
    }
    return r.json.access_token;
  }
  const gget = async (token, pathAndQuery) => {
    const r = await call("GET", "https://gmail.googleapis.com/gmail/v1/users/me/" + pathAndQuery, { headers: { Authorization: "Bearer " + token } });
    if (r.status !== 200 || !r.json) throw new Error("Gmail answered " + r.status);
    return r.json;
  };
  async function pool(items, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
    }));
    return out;
  }
  async function fetchAccount(acct, now) {
    const token = await accessToken(acct);
    const lists = [
      ["in:inbox newer_than:21d -category:promotions -category:social -category:updates -category:forums", "needAnswer"],
      ["in:sent newer_than:45d", "sentNoReply"],
    ];
    const items = { needAnswer: [], sentNoReply: [] };
    for (const [q, want] of lists) {
      const l = await gget(token, "threads?maxResults=" + THREADS_PER_LIST + "&q=" + encodeURIComponent(q));
      const ids = ((l.threads) || []).map((t) => t.id).filter((x) => /^[0-9a-f]+$/i.test(String(x)));
      const threads = await pool(ids, (id) => gget(token, "threads/" + id + "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID"));
      for (const th of threads) {
        if (!th) continue;
        const c = classifyThread(th, acct.email, now);
        if (c.kind === want) items[want].push(Object.assign({ account: acct.email, owner: "Personal Assistant" }, c));
      }
    }
    return items;
  }

  async function addAccount() {
    if (!configured()) return { ok: false, reason: "Gmail is not set up on this PC yet (no Google connection file)." };
    if (typeof openExternal !== "function") return { ok: false, reason: "Cannot open the browser here." };
    if (adding) return { ok: false, reason: "A Google sign-in is already open in your browser." };
    if (readAccounts().length >= MAX_ACCOUNTS) return { ok: false, reason: "At most " + MAX_ACCOUNTS + " Gmail accounts." };
    adding = (async () => {
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const state = b64url(crypto.randomBytes(18));
      let server;
      const codeP = new Promise((resolve, reject) => {
        server = http.createServer((rq, rs) => {
          const u = new URL(rq.url, "http://127.0.0.1");
          if (u.pathname !== "/callback") { rs.writeHead(404); return rs.end(); }
          if (u.searchParams.get("state") !== state) { rs.writeHead(400); return rs.end(); }   // stray or forged request: ignore, keep waiting
          const code = u.searchParams.get("code");
          rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          rs.end(code ? "<meta charset=utf-8><body style='font-family:sans-serif;padding:40px'><h2>Done</h2><p>You can close this tab and go back to Agent Desktop.</p>" : "<meta charset=utf-8><body style='font-family:sans-serif;padding:40px'><h2>Not connected</h2><p>Go back to Agent Desktop and try again.</p>");
          if (code) resolve(code); else reject(new Error(u.searchParams.get("error") || "Google did not give permission"));
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1");
        setTimeout(() => reject(new Error("The Google sign-in was not finished in 5 minutes")), AUTH_TIMEOUT_MS).unref();
      });
      try {
        await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
        const redirect = "http://127.0.0.1:" + server.address().port + "/callback";
        const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
          client_id: client.clientId, redirect_uri: redirect, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent select_account",
          code_challenge: challenge, code_challenge_method: "S256", state,
        }).toString();
        openExternal(authUrl);
        const code = await codeP;
        const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" }).toString();
        const tr = await call("POST", "https://oauth2.googleapis.com/token", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
        if (tr.status !== 200 || !tr.json || !tr.json.refresh_token || !tr.json.access_token) throw new Error("Google did not return a sign-in (" + ((tr.json && tr.json.error) || tr.status) + ")");
        const prof = await gget(tr.json.access_token, "profile");
        const email = clean(prof.emailAddress, 120).toLowerCase();
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Could not read the account address");
        const list = readAccounts().filter((a) => a.email !== email);
        list.push({ email, refresh: tr.json.refresh_token, added: Date.now() });
        writeAccounts(list);
        cache.delete(email);
        return { ok: true, email };
      } finally { try { server.close(); } catch (e) { /* closed */ } }
    })().catch((e) => ({ ok: false, reason: clean(e && e.message, 200) })).finally(() => { adding = null; });
    return adding;
  }

  return {
    configured, classifyThread,
    list: () => readAccounts().map((a) => { const c = cache.get(a.email) || {}; return { email: a.email, ok: !!c.at && !c.error, error: c.error || "", needAnswer: c.items ? c.items.needAnswer.length : 0, sentNoReply: c.items ? c.items.sentNoReply.length : 0 }; }),
    addAccount,
    remove(email) {
      const list = readAccounts();
      const keep = list.filter((a) => a.email !== String(email).toLowerCase());
      if (keep.length === list.length) return { ok: false, reason: "No such account." };
      writeAccounts(keep); cache.delete(String(email).toLowerCase());
      return { ok: true };
    },
    // -> { connected, accounts:[email], emails:{needAnswer,sentNoReply}, updatedAt }
    async load(now, opts) {
      const accts = readAccounts();
      if (!configured() || !accts.length) return { connected: false, accounts: [], emails: { needAnswer: [], sentNoReply: [] } };
      await Promise.all(accts.map(async (a) => {
        const c = cache.get(a.email);
        if (!(opts && opts.force) && c && c.at && Date.now() - c.at < FRESH_MS) return;
        try { cache.set(a.email, { at: Date.now(), items: await fetchAccount(a, now), error: "" }); }
        catch (e) { const prev = cache.get(a.email) || {}; cache.set(a.email, { at: prev.at || 0, items: prev.items, error: clean(e && e.message, 160) }); say("gmail refresh failed: " + clean(e && e.message, 160)); }
      }));
      const emails = { needAnswer: [], sentNoReply: [] };
      let any = false, updatedAt = 0;
      for (const a of accts) {
        const c = cache.get(a.email);
        if (c && c.items) { any = true; updatedAt = Math.max(updatedAt, c.at); emails.needAnswer.push(...c.items.needAnswer); emails.sentNoReply.push(...c.items.sentNoReply); }
      }
      const byAge = (x, y) => y.ageDays - x.ageDays;
      emails.needAnswer.sort(byAge); emails.sentNoReply.sort(byAge);
      return { connected: any, accounts: accts.map((a) => a.email), emails, updatedAt };
    },
  };
}

module.exports = { create, classifyThread, SCOPE };

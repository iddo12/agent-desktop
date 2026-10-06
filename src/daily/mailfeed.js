// My Daily - local mail feed (read-only). The Personal Assistant agent indexes Betterbird's mail files and writes
// waiting_on.json (atomic rename); this module only READS that file and maps it to the Emails tab's shape.
// Schema: { generated, source, items: [{ messageId, direction: "sent"|"received", date (ISO), account, counterparty,
//   subject, daysWaiting?, snippet?, folder }] }. Dedupe key = Message-ID (lowercased, angle brackets stripped),
// the same key a Google (Gmail API) provider will use, so one mail from both routes is shown once.
const fs = require("fs");

const DAY = 86400000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_LIST = 300;
const DEFAULT_FILE = "E:/Claude work/Personal Assistant Agent/mail_index/waiting_on.json";

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const normId = (v) => clean(v, 300).replace(/^<|>$/g, "").toLowerCase();
function accountLabel(a) {
  const s = clean(a, 120);
  if (!s || /^local folders$/i.test(s)) return "Betterbird";
  const i = s.lastIndexOf("/");
  return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s;
}

// Returns { connected, label, accounts, emails, updatedAt, counts } or { connected:false, reason }.
function loadMailFeed(file, now) {
  const f = file || DEFAULT_FILE;
  let st, raw;
  try {
    st = fs.statSync(f);
    if (!st.isFile() || st.size > MAX_BYTES) return { connected: false, reason: "feed file missing or too large" };
    raw = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) { return { connected: false, reason: "feed unreadable: " + clean(e && e.message, 120) }; }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return { connected: false, reason: "feed has no items list" };
  const seen = new Set();
  const needAnswer = [], sentNoReply = [], accounts = [];
  for (const it of raw.items) {
    if (!it || typeof it !== "object") continue;
    const id = normId(it.messageId);
    const dir = it.direction === "sent" ? "sent" : it.direction === "received" ? "received" : null;
    const t = Date.parse(it.date);
    if (!id || !dir || !Number.isFinite(t)) continue;
    const key = dir + ":" + id;
    if (seen.has(key)) continue;
    seen.add(key);
    const account = accountLabel(it.account);
    if (!accounts.includes(account)) accounts.push(account);
    const days = (it.daysWaiting != null && it.daysWaiting !== "" && Number.isFinite(Number(it.daysWaiting))) ? Math.max(0, Math.floor(Number(it.daysWaiting))) : Math.max(0, Math.floor((now - t) / DAY));
    const base = { id, account, subject: clean(it.subject, 200) || "(no subject)", ageDays: days, owner: "Personal Assistant", at: t };
    if (dir === "received") needAnswer.push(Object.assign(base, { from: clean(it.counterparty, 160) }));
    else sentNoReply.push(Object.assign(base, { to: clean(it.counterparty, 160) }));
  }
  needAnswer.sort((a, b) => a.ageDays - b.ageDays); sentNoReply.sort((a, b) => b.ageDays - a.ageDays);
  const gen = Date.parse(raw.generated);
  const updatedAt = Number.isFinite(gen) ? gen : st.mtimeMs;
  return {
    connected: true, updatedAt, accounts,
    label: "Betterbird local feed connected (read-only)",
    counts: { needAnswer: needAnswer.length, sentNoReply: sentNoReply.length },
    emails: { top: [], needAnswer: needAnswer.slice(0, MAX_PER_LIST), sentNoReply: sentNoReply.slice(0, MAX_PER_LIST), peopleToWrite: [], hidden: Math.max(0, needAnswer.length - MAX_PER_LIST) + Math.max(0, sentNoReply.length - MAX_PER_LIST) },
  };
}

// Merge several sources (Betterbird feed, Gmail accounts): one entry per direction + Message-ID, oldest first.
function mergeEmails(list) {
  const out = { top: [], needAnswer: [], sentNoReply: [], peopleToWrite: [], hidden: 0 };
  const seen = new Set();
  for (const em of list) {
    for (const k of ["needAnswer", "sentNoReply"]) {
      for (const x of (em && em[k]) || []) {
        const key = k + ":" + x.id;
        if (seen.has(key)) continue;
        seen.add(key);
        out[k].push(x);
      }
    }
    out.hidden += (em && em.hidden) || 0;
  }
  out.needAnswer.sort((a, b) => a.ageDays - b.ageDays);       // newest first
  out.sentNoReply.sort((a, b) => b.ageDays - a.ageDays);      // longest waiting first
  out.needAnswer = out.needAnswer.slice(0, MAX_PER_LIST); out.sentNoReply = out.sentNoReply.slice(0, MAX_PER_LIST);
  return out;
}

// ---- keep/hide rules (owned by the Personal Assistant agent; Iddo defines them with it) --------------------------------------
// mail_rules.json: { hideSenders: ["substring of From", ...], hideSubjects: ["..."], vipSenders: ["..."], needAnswerMaxDays: 14, topDays: 2, topMax: 8 }
// vipSenders always show (and rank top); hide* drop an entry; everything is plain case-insensitive substring matching.
const DEFAULT_RULES = "E:/Claude work/Personal Assistant Agent/mail_index/mail_rules.json";
function loadRules(file) {
  try {
    const f = file || DEFAULT_RULES;
    const st = fs.statSync(f);
    if (!st.isFile() || st.size > 256 * 1024) return {};
    const r = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
    const list = (v) => (Array.isArray(v) ? v.map((x) => clean(x, 120).toLowerCase()).filter(Boolean).slice(0, 500) : []);
    return { hideSenders: list(r.hideSenders), hideSubjects: list(r.hideSubjects), vipSenders: list(r.vipSenders),
      needAnswerMaxDays: Number.isFinite(Number(r.needAnswerMaxDays)) ? Math.max(1, Math.min(90, Number(r.needAnswerMaxDays))) : null,
      topDays: Number.isFinite(Number(r.topDays)) ? Math.max(1, Math.min(14, Number(r.topDays))) : null,
      keepSubjects: list(r.keepSubjects), keepSenders: list(r.keepSenders), ownDomains: Array.isArray(r.ownDomains) ? list(r.ownDomains) : null,
      relevance: r.relevance === "all" ? "all" : "people",
      topMax: Number.isFinite(Number(r.topMax)) ? Math.max(1, Math.min(20, Number(r.topMax))) : null };
  } catch (e) { return {}; }
}
// 2026-10-06 (Iddo: "I mostly see spam or irrelevant automatic mail"): by default "needs an answer" now shows only mail that looks like it
// comes from a PERSON (display name + a personal-looking address, not a role/robot mailbox, not your own sites' system mail), or that Gmail itself
// marked Important/Starred, or that your rules say to keep (vipSenders, keepSenders, keepSubjects). Set "relevance":"all" in mail_rules.json to see everything.
const ROLE_LOCAL = /^(info|contact|support|sales|admin|administrator|hello|hi|team|office|help|service|services|billing|accounts?|orders?|news|newsletter|updates?|alerts?|notifications?|notify|no[-_]?reply|do[-_]?not[-_]?reply|mailer|marketing|promo|offers?|deals?|ae-|bounce|system|wordpress|webmaster|postmaster)([._-]|\d|$)/i;
const OWN_DOMAINS = ["lensvid.com", "megapixel.co.il", "veggiez.co.il", "shooteat.co.il"];
function addrParts(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(from || ""));
  const addr = (m ? m[2] : String(from || "")).trim().toLowerCase();
  const name = m ? m[1].trim() : "";
  const at = addr.lastIndexOf("@");
  return { name, local: at > 0 ? addr.slice(0, at) : addr, domain: at > 0 ? addr.slice(at + 1) : "" };
}
function personLike(x, own) {
  const p = addrParts(x.from);
  if (!p.local || !p.domain) return false;
  if (ROLE_LOCAL.test(p.local)) return false;
  if ((own || OWN_DOMAINS).some((d) => p.domain === d || p.domain.endsWith("." + d))) return false;
  if (/^(deals|selection|mail|email|e|news|em|bounce|notify|notifications|mailer|marketing|send|smtp)\./i.test(p.domain)) return false;   // bulk-sending subdomains
  return true;
}

// Apply rules and build the "Top emails today" list (importance 3 = VIP or starred/important, 2 = unread, 1 = other) from recent person mail.
function shapeEmails(em, rules, now) {
  const r = rules || {};
  const has = (hay, needles) => (needles || []).some((n) => hay.includes(n));
  const vip = (x) => has(String(x.from || "").toLowerCase(), r.vipSenders);
  const keep = (x, isNeed) => {
    if (vip(x)) return true;
    if (has(String(x.from || "").toLowerCase(), r.keepSenders) || has(String(x.subject || "").toLowerCase(), r.keepSubjects)) return true;
    if (isNeed && r.relevance !== "all" && !x.important && !personLike(x, r.ownDomains)) return false;
    if (has(String(x.from || x.to || "").toLowerCase(), r.hideSenders) || has(String(x.subject || "").toLowerCase(), r.hideSubjects)) return false;
    if (isNeed && r.needAnswerMaxDays != null && x.ageDays > r.needAnswerMaxDays) return false;
    return true;
  };
  const out = Object.assign({}, em, { needAnswer: (em.needAnswer || []).filter((x) => keep(x, true)), sentNoReply: (em.sentNoReply || []).filter((x) => keep(x, false)) });
  const topDays = r.topDays || 2, topMax = r.topMax || 8;
  out.top = out.needAnswer.filter((x) => x.ageDays <= topDays).map((x) => ({
    id: x.id, account: x.account, from: x.from, subject: x.subject,
    at: Number.isFinite(x.at) ? x.at : now - x.ageDays * DAY,
    importance: vip(x) || x.important ? 3 : x.unread ? 2 : 1,
  })).sort((a, b) => b.importance - a.importance || b.at - a.at).slice(0, topMax);
  return out;
}

module.exports = { loadMailFeed, mergeEmails, loadRules, shapeEmails, DEFAULT_FILE, normId };

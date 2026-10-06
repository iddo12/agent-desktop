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
    const base = { id, account, subject: clean(it.subject, 200) || "(no subject)", ageDays: days, owner: "Personal Assistant" };
    if (dir === "received") needAnswer.push(Object.assign(base, { from: clean(it.counterparty, 160) }));
    else sentNoReply.push(Object.assign(base, { to: clean(it.counterparty, 160) }));
  }
  const byAge = (a, b) => b.ageDays - a.ageDays;
  needAnswer.sort(byAge); sentNoReply.sort(byAge);
  const gen = Date.parse(raw.generated);
  const updatedAt = Number.isFinite(gen) ? gen : st.mtimeMs;
  return {
    connected: true, updatedAt, accounts,
    label: "Betterbird local feed connected (read-only)",
    counts: { needAnswer: needAnswer.length, sentNoReply: sentNoReply.length },
    emails: { top: [], needAnswer: needAnswer.slice(0, MAX_PER_LIST), sentNoReply: sentNoReply.slice(0, MAX_PER_LIST), peopleToWrite: [], hidden: Math.max(0, needAnswer.length - MAX_PER_LIST) + Math.max(0, sentNoReply.length - MAX_PER_LIST) },
  };
}

module.exports = { loadMailFeed, DEFAULT_FILE, normId };

// My Daily - calendar sources (read-only). A source is Google Calendar's "secret address in iCal format". The link is a
// secret: it is stored only in this PC's app data folder (never in Dropbox, never sent to the renderer, never logged;
// the UI only gets the name and the last 4 characters). Fetching is https to calendar.google.com only, size and time capped.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { parseIcs } = require("./ics");

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const FRESH_MS = 5 * 60 * 1000;
const MAX_SOURCES = 6;
const DAY = 86400000;
const WINDOW_BACK = 62 * DAY, WINDOW_FWD = 190 * DAY;

function validateUrl(raw) {
  let s = String(raw || "").trim();
  if (/^webcal:\/\//i.test(s)) s = "https://" + s.slice(9);
  let u;
  try { u = new URL(s); } catch (e) { return { error: "That is not a web link." }; }
  if (u.protocol !== "https:" || u.hostname !== "calendar.google.com") return { error: "Use the link from Google Calendar (it starts with https://calendar.google.com/calendar/ical/)." };
  if (!/^\/calendar\/ical\/[^/]+\/(private|public)(-[^/]*)?\/basic\.ics$/i.test(u.pathname)) return { error: "That link is not the \"Secret address in iCal format\" (it ends with basic.ics)." };
  if (s.length > 600) return { error: "That link is too long." };
  return { url: u.toString() };
}
const cleanName = (v) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "Calendar";

function fetchText(url, hops) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fin = (fn, v) => { if (!done) { done = true; fn(v); } };
    const req = https.get(url, { headers: { "User-Agent": "AgentDesktop-MyDaily/1", Accept: "text/calendar" }, timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 3) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url); } catch (e) { return fin(reject, new Error("bad redirect")); }
        if (next.protocol !== "https:" || next.hostname !== "calendar.google.com") return fin(reject, new Error("redirected away from Google"));
        return fetchText(next.toString(), (hops || 0) + 1).then((v) => fin(resolve, v), (e) => fin(reject, e));
      }
      if (res.statusCode !== 200) { res.resume(); return fin(reject, new Error(res.statusCode === 404 || res.statusCode === 403 ? "Google no longer accepts this link (it was reset or the calendar was removed)" : "Google answered " + res.statusCode)); }
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error("calendar file is too large")); return; } chunks.push(c); });
      res.on("end", () => fin(resolve, Buffer.concat(chunks).toString("utf8")));
      res.on("error", (e) => fin(reject, e));
    });
    req.on("timeout", () => req.destroy(new Error("Google did not answer in time")));
    req.on("error", (e) => fin(reject, e));
  });
}

function create({ dataDir, fetcher, log }) {
  const file = path.join(dataDir, "calendar-sources.json");
  const say = typeof log === "function" ? log : () => {};
  const get = fetcher || fetchText;
  const state = new Map();   // url -> { events, updatedAt, error, loading }
  let inflight = null;

  function readSources() {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      return (Array.isArray(v.sources) ? v.sources : []).filter((x) => x && typeof x.url === "string" && validateUrl(x.url).url).slice(0, MAX_SOURCES).map((x) => ({ name: cleanName(x.name), url: x.url }));
    } catch (e) { return []; }
  }
  function writeSources(list) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ sources: list }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const view = (s) => {
    const st = state.get(s.url) || {};
    return { name: s.name, tail: s.url.replace(/\/basic\.ics$/i, "").slice(-4), ok: !!st.updatedAt && !st.error, error: st.error || "", count: st.events ? st.events.length : 0, updatedAt: st.updatedAt || null };
  };

  async function refreshOne(s, now) {
    const st = state.get(s.url) || {};
    try {
      const text = await get(s.url);
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("that link did not return a calendar");
      st.events = parseIcs(text, now - WINDOW_BACK, now + WINDOW_FWD).map((e) => Object.assign(e, { calName: s.name }));
      st.updatedAt = Date.now(); st.error = "";
    } catch (e) {
      st.error = String((e && e.message) || e).replace(s.url, "").slice(0, 160);   // never echo the link
      say("calendar refresh failed: " + st.error);
    }
    state.set(s.url, st);
  }
  async function refresh(now, force) {
    const sources = readSources();
    const stale = sources.filter((s) => { const st = state.get(s.url); return force || !st || !st.updatedAt || Date.now() - st.updatedAt > FRESH_MS; });
    if (!stale.length) return;
    if (inflight) return inflight;
    inflight = Promise.all(stale.map((s) => refreshOne(s, now))).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    validateUrl,
    // Events for the payload. The first load waits (up to the fetch timeout); a stale load returns what it has and refreshes in the background.
    async load(now, opts) {
      const sources = readSources();
      const first = sources.some((s) => !state.has(s.url));
      const p = refresh(now, opts && opts.force);
      if (first || (opts && opts.force)) await p;
      else if (p) p.then(() => { if (opts && typeof opts.onUpdated === "function") opts.onUpdated(); }, () => {});
      const events = [];
      for (const s of sources) { const st = state.get(s.url); if (st && st.events) events.push(...st.events); }
      return { events, sources: sources.map(view), connected: sources.some((s) => { const st = state.get(s.url); return st && st.updatedAt; }) };
    },
    add(name, rawUrl) {
      const v = validateUrl(rawUrl);
      if (v.error) return { ok: false, reason: v.error };
      const list = readSources();
      if (list.length >= MAX_SOURCES) return { ok: false, reason: "At most " + MAX_SOURCES + " calendars." };
      if (list.some((x) => x.url === v.url)) return { ok: false, reason: "That calendar is already added." };
      list.push({ name: cleanName(name), url: v.url });
      writeSources(list);
      return { ok: true };
    },
    remove(index) {
      const list = readSources();
      if (!Number.isInteger(index) || index < 0 || index >= list.length) return { ok: false, reason: "No such calendar." };
      const [gone] = list.splice(index, 1);
      state.delete(gone.url);
      writeSources(list);
      return { ok: true };
    },
    list: () => readSources().map(view),
  };
}

module.exports = { create, validateUrl };

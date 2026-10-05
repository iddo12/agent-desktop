// My Daily - "Add from link". Fetches ONE product page (no polling, no price tracking) and pulls out a title,
// an image URL and a price. Everything here is untrusted web data: the caller stores plain strings only and the
// renderer shows them with textContent. Never throws to the caller: a blocked or odd page gives {found:false}.
//
// SSRF protection: https only, at most 3 redirects, every hop re-validated, and the DNS answer is checked at
// connect time (custom `lookup`), so a hostname that resolves to a private address cannot be reached even
// by DNS rebinding. Size cap 2 MB, 10 s timeout.
"use strict";
const https = require("https");
const dns = require("dns");
const net = require("net");
const zlib = require("zlib");

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// true when the address is not a public unicast address (loopback, private, link-local, CGNAT, ULA, mapped, ...)
function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  const s = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isBlockedIp(mapped[1]);
  if (/^::ffff:[0-9a-f:]+$/.test(s)) return true;
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || /^2001:db8/.test(s) || /^64:ff9b/.test(s);
}

// Only a plain https URL to a named host or a public literal IP.
function checkUrl(u) {
  let url;
  try { url = new URL(String(u).trim()); } catch (e) { return { ok: false, reason: "That is not a web address." }; }
  if (url.protocol !== "https:") return { ok: false, reason: "Only https links can be read." };
  if (url.username || url.password) return { ok: false, reason: "Links with a user name are not read." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedIp(host)) return { ok: false, reason: "That address is private." };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, reason: "That address is private." };
  return { ok: true, url };
}

function safeLookup(hostname, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) return cb(new Error("blocked address"));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function decode(buf, enc) {
  const lim = { maxOutputLength: MAX_BYTES };
  if (enc === "gzip") return zlib.gunzipSync(buf, lim);
  if (enc === "deflate") return zlib.inflateSync(buf, lim);
  if (enc === "br") return zlib.brotliDecompressSync(buf, lim);
  return buf;
}

// One request, no redirect following. Resolves {status, headers, body(Buffer)} or rejects.
function getOnce(url, accept, lookup) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET", lookup: lookup || safeLookup, timeout: TIMEOUT_MS,
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9", "Accept-Encoding": "gzip, deflate, br" },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error("too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: decode(Buffer.concat(chunks), String(res.headers["content-encoding"] || "").toLowerCase()) }); }
        catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

// Follows up to 3 redirects, re-checking every hop. Resolves {status, body, url} or rejects.
async function guardedGet(u, accept, lookup) {
  let cur = u;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const c = checkUrl(cur);
    if (!c.ok) throw new Error(c.reason);
    const r = await getOnce(c.url, accept, lookup);
    if (r.status >= 300 && r.status < 400 && r.headers.location) { cur = new URL(r.headers.location, c.url).toString(); continue; }
    return { status: r.status, body: r.body, headers: r.headers, url: c.url.toString() };
  }
  throw new Error("too many redirects");
}

// ---------------------------------------------------------------- parsing (pure, tested with saved HTML)
function unescapeHtml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">";
    if (k === "quot") return '"'; if (k === "apos") return "'"; if (k === "nbsp") return " ";
    const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
  });
}
const clean = (s, max) => unescapeHtml(String(s == null ? "" : s)).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max || 200);

function metaContent(html, key) {
  const re = new RegExp(`<meta\\b[^>]*?(?:property|name|itemprop)\\s*=\\s*["']${key}["'][^>]*>`, "i");
  const m = re.exec(html);
  if (!m) return "";
  const c = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(m[0]);
  return c ? clean(c[1] != null ? c[1] : c[2], 500) : "";
}
function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1].trim())); } catch (e) { /* ignore bad block */ } }
  return out;
}
function* walk(node, depth) {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) { for (const x of node) yield* walk(x, depth + 1); return; }
  if (typeof node === "object") { yield node; if (node["@graph"]) yield* walk(node["@graph"], depth + 1); }
}
const typeIs = (o, t) => [].concat(o["@type"] || []).some((x) => String(x).toLowerCase() === t);
function offerPrice(offers) {
  for (const o of [].concat(offers || [])) {
    if (!o || typeof o !== "object") continue;
    const p = o.price != null ? o.price : (o.priceSpecification && o.priceSpecification.price) != null ? o.priceSpecification.price : o.lowPrice;
    if (p != null && String(p).trim() !== "" && Number.isFinite(Number(String(p).replace(/,/g, "")))) return { amount: String(p).replace(/,/g, ""), currency: o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency) || "" };
  }
  return null;
}
const SYMBOLS = { USD: "$", EUR: "€", GBP: "£", ILS: "₪", JPY: "¥", CAD: "CA$", AUD: "A$" };
function fmtPrice(p) {
  if (!p) return "";
  const n = Number(p.amount);
  const txt = Number.isFinite(n) ? n.toFixed(2) : p.amount;
  const cur = String(p.currency || "").toUpperCase().slice(0, 3);
  return SYMBOLS[cur] ? SYMBOLS[cur] + txt : cur ? `${txt} ${cur}` : txt;
}

// -> {found, title, image (absolute https URL or ""), price ("$64.00" or "")}
function parseProduct(html, pageUrl) {
  html = String(html || "").slice(0, MAX_BYTES);
  let title = "", image = "", price = null;
  for (const block of jsonLdBlocks(html)) {
    for (const o of walk(block, 0)) {
      if (!typeIs(o, "product")) continue;
      if (!title && o.name) title = clean(o.name, 200);
      if (!image && o.image) { const im = [].concat(o.image)[0]; image = clean(typeof im === "object" && im ? im.url || "" : im, 600); }
      if (!price) price = offerPrice(o.offers);
    }
  }
  if (!title) title = clean(metaContent(html, "og:title") || metaContent(html, "twitter:title"), 200);
  if (!title) { const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); if (t) title = clean(t[1], 200); }
  if (!image) image = metaContent(html, "og:image") || metaContent(html, "twitter:image") || metaContent(html, "image");
  if (!price) {
    const amount = metaContent(html, "product:price:amount") || metaContent(html, "og:price:amount") || metaContent(html, "price");
    if (amount && Number.isFinite(Number(amount.replace(/,/g, "")))) price = { amount: amount.replace(/,/g, ""), currency: metaContent(html, "product:price:currency") || metaContent(html, "og:price:currency") || metaContent(html, "priceCurrency") };
  }
  if (!price) {
    const m = /(?:["'>\s])(US\$|\$|€|£|₪)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})(?!\d)/.exec(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
    if (m) price = { amount: m[2].replace(/,/g, ""), currency: { "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP", "₪": "ILS" }[m[1]] };
  }
  let img = "";
  if (image) { try { const u = new URL(image, pageUrl); if (u.protocol === "https:") img = u.toString(); } catch (e) { /* ignore */ } }
  // Captcha / robot pages are not products.
  const robot = /captcha|robot check|are you a human|access denied|enter the characters you see/i.test(title);
  if (robot) { title = ""; img = ""; price = null; }
  return { found: !!title, title, image: img, price: fmtPrice(price) };
}

const SOURCES = { "amazon": "Amazon", "bhphotovideo": "B&H", "aliexpress": "AliExpress", "ebay": "eBay", "iherb": "iHerb", "etsy": "Etsy", "adorama": "Adorama", "walmart": "Walmart", "ksp": "KSP", "zap": "Zap" };
// Short tag from the hostname: known stores by name, anything else by its domain.
function sourceTag(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  for (const p of parts) if (SOURCES[p]) return SOURCES[p];
  return h;
}

// Fetch page + parse. Always resolves: {found, title, image, price, source, link, reason?}
async function fetchProduct(u, lookup) {
  const c = checkUrl(u);
  const base = { found: false, title: "", image: "", price: "", source: "", link: "" };
  if (!c.ok) return Object.assign(base, { reason: c.reason, rejected: true });
  base.source = sourceTag(c.url.hostname);
  base.link = c.url.toString();
  try {
    const r = await guardedGet(base.link, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", lookup);
    base.link = r.url;
    base.source = sourceTag(new URL(r.url).hostname);
    if (r.status >= 400) return Object.assign(base, { reason: `The site answered ${r.status}.` });
    return Object.assign(base, parseProduct(r.body.toString("utf8"), r.url));
  } catch (e) {
    return Object.assign(base, { reason: String((e && e.message) || e).slice(0, 120) });
  }
}

module.exports = { isBlockedIp, checkUrl, guardedGet, parseProduct, sourceTag, fetchProduct, safeLookup, MAX_BYTES, MAX_REDIRECTS };

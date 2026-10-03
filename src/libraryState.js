// Per-user Library state (v1.64.0): which documents Iddo has read, and what he sent to whom about them.
// Lives in Agent Desktop's own data dir (NOT the shared registry, which every agent sees), as one small
// JSON file. Loaded once, kept in memory, written (tmp + rename) only when something changes - no polling.
const fs = require("fs");
const path = require("path");

const MAX_COMMENT = 20000;
const MAX_HISTORY_PER_DOC = 50;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function create(filePath) {
  let state = null;

  function load() {
    if (state) return state;
    try {
      const v = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      state = v && typeof v === "object" ? v : {};
    } catch (e) {
      state = {};
    }
    if (!state.read || typeof state.read !== "object") state.read = {};
    if (!state.history || typeof state.history !== "object") state.history = {};
    return state;
  }

  function save() {
    const tmp = filePath + ".tmp";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  }

  function get() {
    const s = load();
    return { read: s.read, history: s.history };
  }

  // op: {op:"read", id, value:boolean} | {op:"history", id, record:{to, toName, action, comment, path, title}}
  function apply(op) {
    const s = load();
    if (!op || !ID_RE.test(String(op.id || ""))) return { ok: false, error: "Bad document id." };
    if (op.op === "read") {
      if (op.value) s.read[op.id] = { at: new Date().toISOString() };
      else delete s.read[op.id];
    } else if (op.op === "history") {
      const r = op.record || {};
      const rec = {
        at: new Date().toISOString(),
        to: String(r.to || "").slice(0, 200),
        toName: String(r.toName || "").slice(0, 200),
        action: String(r.action || "").slice(0, 100),
        comment: String(r.comment || "").slice(0, MAX_COMMENT),
      };
      const list = Array.isArray(s.history[op.id]) ? s.history[op.id] : [];
      list.push(rec);
      s.history[op.id] = list.slice(-MAX_HISTORY_PER_DOC);
    } else {
      return { ok: false, error: "Unknown op." };
    }
    try { save(); } catch (e) { return { ok: false, error: "Could not save: " + e.message }; }
    return { ok: true };
  }

  return { get, apply };
}

module.exports = { create };

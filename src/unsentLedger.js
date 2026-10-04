// v1.69.15: pure helpers for the unsent-message ledger (renderer: window.UnsentLedger, main/tests: require).
// A message Iddo sent is written to disk until the agent's transcript proves it arrived. After an app restart,
// anything still unproven (and the agent is idle, so it cannot be "queued in the CLI") goes back to the visible
// send queue once. Deterministic, unit-tested in tests/unsentLedger.test.js.
(function (root) {
  const TTL_MS = 24 * 3600 * 1000;
  const IDLE_BEFORE_RECOVER_MS = 20000;
  const norm = (s) => String(s == null ? "" : s).replace(/<\/?pasted_content[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  // blocks: [{role, lines:[...], timestamp}] as built by the transcript reader.
  function delivered(blocks, entry) {
    const n = norm(entry.text);
    if (!n) return true;
    const fp = n.slice(-80).trim();
    return (blocks || []).some((b) => {
      if (!b || b.role !== "user") return false;
      if (b.timestamp && new Date(b.timestamp).getTime() < entry.sentAt - 2000) return false;
      const t = norm((b.lines || []).join(" "));
      return t === n || (fp.length >= 20 && t.includes(fp));
    });
  }

  function serialize(map) {
    const o = {};
    for (const [ap, list] of map.entries()) {
      const items = list.filter((e) => e && typeof e.text === "string" && e.text && e.sentAt).map((e) => ({ text: e.text, sentAt: e.sentAt }));
      if (items.length) o[ap] = items;
    }
    return JSON.stringify(o);
  }

  // Loaded entries are flagged disk:true: they come from before this run of the app.
  function parse(json, now) {
    const m = new Map();
    try {
      const o = JSON.parse(json);
      for (const ap of Object.keys(o || {})) {
        const items = (Array.isArray(o[ap]) ? o[ap] : [])
          .filter((e) => e && typeof e.text === "string" && e.text && typeof e.sentAt === "number" && now - e.sentAt < TTL_MS)
          .map((e) => ({ text: e.text, sentAt: e.sentAt, disk: true }));
        if (items.length) m.set(ap, items);
      }
    } catch (e) { /* corrupt file: start empty */ }
    return m;
  }

  // What to do with one ledger entry on a tick. ctx: {now, blocks, started, idleForMs, queued:[texts], pending:[texts]}
  // -> "drop" (proven delivered / expired / already handled) | "recover" | "keep"
  function decide(entry, ctx) {
    if (ctx.now - entry.sentAt >= TTL_MS) return "drop";
    if (ctx.blocks && ctx.blocks.length && delivered(ctx.blocks, entry)) return "drop";
    if (!entry.disk) return "keep";                                        // sent in this run: the normal Not-confirmed flow owns it
    const n = norm(entry.text);
    if ((ctx.queued || []).some((q) => norm(q) === n)) return "drop";     // already waiting in the visible queue
    if ((ctx.pending || []).some((q) => norm(q) === n)) return "drop";    // the user resent it by hand
    if (!ctx.started || !ctx.blocks || !ctx.blocks.length) return "keep";  // transcript not loaded yet: cannot judge
    if ((ctx.idleForMs || 0) < IDLE_BEFORE_RECOVER_MS) return "keep";      // agent may still be about to read it
    return "recover";
  }

  const api = { TTL_MS, IDLE_BEFORE_RECOVER_MS, norm, delivered, serialize, parse, decide };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.UnsentLedger = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

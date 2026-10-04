// v1.69.15: keeps every message Iddo sends on disk until the transcript proves it arrived; after an app restart an
// unproven message (agent idle, so it cannot still be queued in the CLI) goes back to the visible send queue once.
// Fix for "Not confirmed" messages that vanished when Agent Desktop was restarted. No renderer.js changes: it only
// watches terminals[].pendingSent and lastBlocks. Logic is in src/unsentLedger.js.
(function () {
  if (!window.UnsentLedger || !window.api || !window.api.ledgerSave) return;
  const L = window.UnsentLedger;
  const ledger = new Map();            // agentPath -> [{text, sentAt, disk?}]
  const idleSince = new Map();         // agentPath -> ms when it became idle
  let dirty = false, loaded = false;

  const has = (ap, text, sentAt) => (ledger.get(ap) || []).some((e) => e.text === text && Math.abs(e.sentAt - sentAt) < 5000);
  function add(ap, text, sentAt) {
    if (has(ap, text, sentAt)) return;
    if (!ledger.has(ap)) ledger.set(ap, []);
    ledger.get(ap).push({ text, sentAt });
    dirty = true;
  }
  const isOwn = (t) => t.indexOf("[Agent Desktop") === 0 || /^\[hid:[^\]]+\]/.test(t);   // handoff/flow prompts have their own tracking

  function tick() {
    const now = Date.now();
    for (const [ap, se] of terminals.entries()) {
      if (!se) continue;
      for (const p of se.pendingSent || []) {
        if (p && !p.provisional && typeof p.text === "string" && p.text && !isOwn(p.text)) add(ap, p.text, p.sentAt || p.addedAt || now);
      }
      const working = !!(se.started && (se.busy || se.transcriptWorking));
      if (working || !se.started) idleSince.delete(ap); else if (!idleSince.has(ap)) idleSince.set(ap, now);
    }
    if (!loaded) return;
    for (const [ap, list] of Array.from(ledger.entries())) {
      const se = terminals.get(ap);
      const keep = [];
      for (const e of list) {
        const verdict = L.decide(e, {
          now, blocks: se && se.lastBlocks, started: !!(se && se.started),
          idleForMs: idleSince.has(ap) ? now - idleSince.get(ap) : 0,
          queued: se ? se.sendQueue : [], pending: se ? (se.pendingSent || []).map((p) => p.text) : [],
        });
        if (verdict === "keep") { keep.push(e); continue; }
        dirty = true;
        if (verdict === "recover") {
          try {
            se.sendQueue.unshift(e.text);
            if (typeof renderQueue === "function") renderQueue(ap);
            try { window.autoHandoffLog("recovered 1 unsent message after a restart for " + String(ap).split(/[\\/]/).pop()); } catch (x) {}
            if (!se.busy && !se.transcriptWorking && typeof setBusy === "function") setBusy(ap, se, false);
          } catch (x) { keep.push(e); }
        }
      }
      if (keep.length) ledger.set(ap, keep); else ledger.delete(ap);
    }
    if (dirty) {
      dirty = false;
      try { window.api.ledgerSave(L.serialize(ledger)); } catch (e) { /* never break the chat */ }
    }
  }

  window.api.ledgerLoad().then((r) => {
    const m = L.parse(r && r.json, Date.now());
    for (const [ap, items] of m.entries()) {
      const cur = ledger.get(ap) || [];
      ledger.set(ap, items.filter((i) => !cur.some((c) => c.text === i.text && Math.abs(c.sentAt - i.sentAt) < 5000)).concat(cur));
    }
    loaded = true;
  }).catch(() => { loaded = true; });
  setInterval(() => { try { tick(); } catch (e) { console.error("unsent-ledger", e); } }, 4000);
  window.unsentLedgerState = () => Array.from(ledger.entries());   // sandbox tests
})();

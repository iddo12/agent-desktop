// v1.63.4: delivery of auto-handoff prompts WITH an acknowledgement. Works in node (tests, main)
// and as a plain <script> in the renderer (attaches window.HandoffDelivery).
//
// Why: on the live fleet (v1.63.1, SEO agent, 2026-10-03) the handoff request typed into a
// background agent's pty never landed - banner "Not confirmed" x3, 12 min timeout - while a
// SendMessage-style delivery over the agent's message pipe did. So: (1) try the message channel
// first, (2) fall back to pty typing only if the channel is unavailable, (3) after every send check
// that a unique marker from the prompt really appears in the agent's transcript, (4) retry with
// backoff, logging each attempt. All I/O is injected, so the logic is unit-testable.
(function (root) {
  const DEFAULTS = {
    verifyWaitMs: [8000, 20000, 45000],   // how long to wait for the marker after attempt 1, 2, 3
    pollMs: 2500,                          // transcript tail read interval while waiting (cheap, bounded)
    maxAttempts: 3,
  };

  function makeMarker(now) {
    return "[hid:" + (now || Date.now()).toString(36) + Math.floor(Math.random() * 1296).toString(36) + "]";
  }

  const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // deps: { channelSend(text) -> {ok, reason?}, ptySend(text) -> void, transcriptHas(marker) -> bool,
  //         log(line), sleep(ms), now() }
  // Returns { delivered, via, attempts }.
  async function deliver(text, deps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const sleep = deps.sleep || defaultSleep;
    const now = deps.now || Date.now;
    const log = deps.log || (() => {});
    const marker = o.marker || makeMarker(now());
    const body = marker + " " + text;
    let channelUsable = !!deps.channelSend;
    let via = null;
    for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
      let sentVia = null;
      if (channelUsable) {
        let r = null;
        try { r = await deps.channelSend(body); } catch (e) { r = { ok: false, reason: e && e.message }; }
        if (r && r.ok) {
          sentVia = "channel";
          log("handoff-delivery attempt " + attempt + ": sent via message channel (acked)");
        } else {
          channelUsable = false; // pipe unavailable or rejected: type into the pty from now on
          log("handoff-delivery attempt " + attempt + ": message channel unavailable (" + ((r && r.reason) || "no reason") + ") - falling back to pty typing");
        }
      }
      if (!sentVia) {
        try { deps.ptySend(body); sentVia = "pty"; log("handoff-delivery attempt " + attempt + ": typed into pty"); }
        catch (e) { log("handoff-delivery attempt " + attempt + ": pty send FAILED: " + (e && e.message)); }
      }
      if (sentVia) {
        via = sentVia;
        const waitMs = o.verifyWaitMs[Math.min(attempt - 1, o.verifyWaitMs.length - 1)];
        const t0 = now();
        for (;;) {
          let has = false;
          try { has = await deps.transcriptHas(marker); } catch (e) {}
          if (has) {
            log("handoff-delivery attempt " + attempt + ": landed in transcript via " + sentVia);
            return { delivered: true, via: sentVia, attempts: attempt, marker };
          }
          if (now() - t0 >= waitMs) break;
          await sleep(Math.min(o.pollMs, Math.max(0, waitMs - (now() - t0))) || 1);
        }
        log("handoff-delivery attempt " + attempt + ": NOT in transcript after " + Math.round(waitMs / 1000) + "s" + (attempt < o.maxAttempts ? " - retrying" : " - giving up"));
      }
      if (attempt < o.maxAttempts) await sleep(Math.min(5000 * attempt, 15000));
    }
    return { delivered: false, via, attempts: o.maxAttempts, marker };
  }

  // Banner warning: is the handoff file older than the request this flow made?
  function staleInfo(info, flowStartedAt) {
    if (!info || !info.exists || !flowStartedAt) return { stale: false };
    const stale = info.mtimeMs < flowStartedAt;
    return { stale, ageMs: stale ? flowStartedAt - info.mtimeMs : 0 };
  }

  const api = { deliver, makeMarker, staleInfo, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.HandoffDelivery = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

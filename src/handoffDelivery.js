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
  // v1.67.1: a prompt (identified by its hid marker) is typed into the pty AT MOST ONCE, ever. On 2026-10-03 the
  // SE agent got the same long handoff prompt three times: every retry typed it again while the agent was
  // mid-turn and the CLI had already queued the earlier copies (queued_command), so all three landed.
  const typedMarkers = new Set();

  // deps: { channelSend(text, {ttlSec}) -> {ok, reason?}, ptySend(text) -> void, transcriptHas(marker) -> bool,
  //         ptyQueued() -> bool (the prompt is still in the busy-agent send queue), aborted() -> bool,
  //         log(line), sleep(ms), now() }
  // Rules (v1.63.7): the channel is tried AT MOST ONCE per delivery (an acked send that does not land
  // is never re-dropped; later attempts use the pty); a pty retry is skipped while the previous pty
  // prompt is still queued (it would type a duplicate); everything stops once aborted() is true.
  // Returns { delivered, via, attempts, aborted? }.
  async function deliver(text, deps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const sleep = deps.sleep || defaultSleep;
    const now = deps.now || Date.now;
    const log = deps.log || (() => {});
    const aborted = () => { try { return !!(deps.aborted && deps.aborted()); } catch (e) { return false; } };
    const marker = o.marker || makeMarker(now());
    const body = marker + " " + text;
    let channelUsable = !!deps.channelSend;
    let via = null, ptySent = false, channelId = null;
    for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
      if (aborted()) { log("handoff-delivery: stopped (flow no longer active)"); return { delivered: false, via, attempts: attempt - 1, marker, aborted: true }; }
      let sentVia = null, skipped = false;
      if (channelUsable) {
        channelUsable = false; // one channel attempt per delivery, whatever the outcome
        let r = null;
        try { r = await deps.channelSend(body, { ttlSec: o.ttlSec || 120 }); } catch (e) { r = { ok: false, reason: e && e.message }; }
        if (r && r.ok) {
          sentVia = "channel";
          channelId = r.id || null;
          log("handoff-delivery attempt " + attempt + ": sent via message channel (acked)");
        } else {
          log("handoff-delivery attempt " + attempt + ": message channel unavailable (" + ((r && r.reason) || "no reason") + ") - falling back to pty typing");
        }
      }
      if (!sentVia) {
        let queued = false;
        try { queued = ptySent && !!(deps.ptyQueued && deps.ptyQueued()); } catch (e) {}
        if (queued) {
          skipped = true;
          log("handoff-delivery attempt " + attempt + ": previous prompt still queued for a busy agent - not typing a duplicate, waiting");
        } else if (ptySent || typedMarkers.has(marker)) {
          skipped = true;
          log("handoff-delivery attempt " + attempt + ": this prompt (" + marker + ") was already typed once - never typing it twice, waiting for it to land");
        } else {
          // v1.63.8: the acked channel send did not land; withdraw its still-queued request file so a
          // late relay cannot deliver it a second time next to this pty prompt.
          if (channelId && deps.channelCancel) {
            try { await deps.channelCancel(channelId); log("handoff-delivery attempt " + attempt + ": withdrew the unlanded channel request " + channelId); } catch (e) {}
            channelId = null;
          }
          try { typedMarkers.add(marker); deps.ptySend(body); ptySent = true; sentVia = "pty"; log("handoff-delivery attempt " + attempt + ": typed into pty"); }
          catch (e) { log("handoff-delivery attempt " + attempt + ": pty send FAILED: " + (e && e.message)); }
        }
      }
      if (sentVia || skipped) {
        if (sentVia) via = sentVia;
        const waitMs = o.verifyWaitMs[Math.min(attempt - 1, o.verifyWaitMs.length - 1)];
        const t0 = now();
        let lastSubmitLook = -1e12;
        for (;;) {
          let has = false;
          try { has = await deps.transcriptHas(marker); } catch (e) {}
          if (has) {
            log("handoff-delivery attempt " + attempt + ": landed in transcript via " + (sentVia || via));
            return { delivered: true, via: sentVia || via, attempts: attempt, marker };
          }
          if (aborted()) { log("handoff-delivery: stopped (flow no longer active)"); return { delivered: false, via, attempts: attempt, marker, aborted: true }; }
          // v1.68.2: typed but not in the transcript yet: if it sits unsent in the input box, press Enter (at most every 6 s)
          if ((ptySent || via === "pty") && deps.nudgeSubmit && now() - t0 >= 5000 && now() - lastSubmitLook >= 6000) {
            lastSubmitLook = now();
            try { if (await deps.nudgeSubmit()) log("handoff-delivery attempt " + attempt + ": prompt was unsent in the input box - pressed Enter"); } catch (e) {}
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

  // v1.63.8: remove every queued prompt that contains `text` (the busy-agent send queue); returns the count.
  function purgeQueue(queue, text) {
    let n = 0;
    if (!Array.isArray(queue) || !text) return 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (typeof queue[i] === "string" && queue[i].indexOf(text) !== -1) { queue.splice(i, 1); n++; }
    }
    return n;
  }

  // Banner warning: is the handoff file older than the request this flow made?
  function staleInfo(info, flowStartedAt) {
    if (!info || !info.exists || !flowStartedAt) return { stale: false };
    const stale = info.mtimeMs < flowStartedAt;
    return { stale, ageMs: stale ? flowStartedAt - info.mtimeMs : 0 };
  }

  const api = { deliver, purgeQueue, makeMarker, staleInfo, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.HandoffDelivery = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

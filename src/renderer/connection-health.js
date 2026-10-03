// v1.67.0 connection health, renderer half (main half: src/connectionHealth.js). Loaded AFTER renderer.js and
// isolated like guards.js: it only uses renderer.js's globals (terminals, activeAgentPath, renderQueue,
// submitToAgent, renderChatBlocks, rebuildChatView) and every entry point is wrapped in try/catch, so a bug here
// can only disable this feature, never the chat. No timers of its own: the 1 s repaint rides on
// updateThinkingIndicator()'s existing interval and the long-command check rides on rebuildChatView()'s
// existing activity read.
//
//  1. Honest state: while an agent is "not connected" (reconnecting / restarting) the status line says so
//     instead of a stale "Working... NNNs", and messages are HELD in the visible queue ("waiting for reconnect")
//     instead of being written to a dead pty and shown as sent. Messages that were written to the dead link
//     (found by the main process) are pulled back out of "sent" into that queue, and go out once it is back.
//  2. Fallback: when the link stays bad (state "degraded", or 3+ failed reconnects) queued messages are delivered
//     over the same message channel SendMessage uses (window.api.channelSend, needs the relay), if it is up.
//  3. Long foreground command (Bash/PowerShell tool call unanswered > 60 s): a banner says messages wait until
//     it ends, with "Interrupt now (Esc) and deliver".
(function () {
  "use strict";
  const LONG_CMD_MS = 60 * 1000;
  const CHANNEL_AFTER_ATTEMPTS = 3;
  const DRAIN_DELAY_MS = 2500;      // let the freshly attached CLI finish drawing before typing into it
  const AFTER_INTERRUPT_WAIT_MS = 2500;
  const states = new Map();         // agentPath -> main-process snapshot (only non-connected ones are kept)

  function sess(p) { try { return terminals.get(p); } catch (e) { return null; } }
  function lost(p) { const st = states.get(p); return !!st && st.state !== "connected"; }

  // Hold sends while the link is known to be down. "degraded" still goes to the pty (it may work), after one
  // try over the message channel.
  function holding(p) {
    const st = states.get(p);
    return !!st && (st.state === "reconnecting" || st.state === "restarting");
  }

  function bannerEl() {
    let el = document.getElementById("connection-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "connection-banner";
      el.className = "hidden";
      const q = document.getElementById("chat-queue");
      if (q && q.parentNode) q.parentNode.insertBefore(el, q);
    }
    return el;
  }

  function requeue(s, since) {
    if (!s || since == null) return 0;
    const back = s.pendingSent.filter((p) => (p.sentAt || p.addedAt || 0) >= since - 5000);
    if (!back.length) return 0;
    s.pendingSent = s.pendingSent.filter((p) => !back.includes(p));
    for (let i = back.length - 1; i >= 0; i--) {
      if (!s.sendQueue.includes(back[i].text)) s.sendQueue.unshift(back[i].text);
    }
    return back.length;
  }

  function repaintChat(p) {
    try {
      if (p !== activeAgentPath) return;
      const s = sess(p);
      renderQueue(p);
      if (s) renderChatBlocks(s.lastBlocks || [], s.pendingSent, {});
      updateThinkingIndicator();
    } catch (e) { /* cosmetic */ }
  }

  async function channelDeliver(p) {
    const s = sess(p);
    if (!s || !s.sendQueue.length) return;
    s.connChannelTried = s.connChannelTried || new Set();
    for (const text of s.sendQueue.slice()) {
      if (s.connChannelTried.has(text)) continue;
      s.connChannelTried.add(text);
      let r = null;
      try { r = await window.api.channelSend(p, text); } catch (e) { r = null; }
      if (r && r.ok) {
        const i = s.sendQueue.indexOf(text);
        if (i !== -1) s.sendQueue.splice(i, 1);
        const now = Date.now();
        s.pendingSent.push({ text, addedAt: now, sentAt: now });
        window.api.logGuard("connection: queued message delivered over the message channel for " + p);
      } else {
        window.api.logGuard("connection: message channel unavailable for " + p + " (" + ((r && r.reason) || "no reason") + ") - message stays queued");
      }
    }
    repaintChat(p);
  }

  function onState(snap) {
    try {
      const p = snap && snap.agentPath;
      if (!p) return;
      const prev = states.get(p);
      const s = sess(p);
      if (snap.state === "connected") {
        states.delete(p);
        if (s) {
          if (s.connChannelTried) s.connChannelTried.clear();
          s.connLostAt = null;
          // The link is back: deliver what was held. One now (after the CLI settles); the rest drain through
          // the normal idle path (setBusy), exactly like any queued message.
          setTimeout(() => {
            try {
              if (holding(p) || !s.sendQueue.length) return;
              if (s.busy || s.transcriptWorking) return; // normal drain will pick it up when idle
              submitToAgent(p, s.sendQueue.shift());
              renderQueue(p);
            } catch (e) { /* ignore */ }
          }, DRAIN_DELAY_MS);
        }
        repaintChat(p);
        return;
      }
      states.set(p, snap);
      if (s) {
        if (!prev) {
          s.turnStartedAt = null; // no more stale "Working... NNNs" for an agent that is idle behind a dead link
          s.connLostAt = Date.now();
          try { s.term.write("\r\n\x1b[33m[Agent Desktop: not connected to this agent - " + (snap.reason || "reconnecting") + "]\x1b[0m\r\n"); } catch (e) {}
        }
        const n = requeue(s, snap.requeueSince);
        if (n) window.api.logGuard("connection: " + n + " message(s) written to the dead link for " + p + " moved back to the queue");
        if (snap.state === "degraded" || (snap.state === "reconnecting" && snap.attempts >= CHANNEL_AFTER_ATTEMPTS)) channelDeliver(p);
      }
      repaintChat(p);
    } catch (e) { /* never break the chat */ }
  }

  // Called first thing from sendOrHold(). Returns "held" / "channel" when it took the message, else null.
  function interceptSend(p, s, text) {
    try {
      const st = states.get(p);
      if (!st) return null;
      if (holding(p)) {
        s.sendQueue.push(text);
        renderQueue(p);
        if (st.attempts >= CHANNEL_AFTER_ATTEMPTS) channelDeliver(p);
        return "held";
      }
      if (st.state === "degraded") {
        s.sendQueue.push(text);
        renderQueue(p);
        channelDeliver(p).then(() => {
          // channel unavailable: the pty is the last resort (it may still work), so do not strand the message
          const i = s.sendQueue.indexOf(text);
          if (i !== -1) { s.sendQueue.splice(i, 1); renderQueue(p); submitToAgent(p, text); }
        });
        return "channel";
      }
    } catch (e) { /* fall through to the normal path */ }
    return null;
  }

  function fmtSecs(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec >= 120 ? Math.floor(sec / 60) + " min" : sec + "s";
  }

  // Called from updateThinkingIndicator() (every second). Returns true when it has drawn the status line itself.
  function paint(p, indEl) {
    try {
      const st = p && states.get(p);
      const s = p && sess(p);
      const banner = bannerEl();
      let bannerText = "";
      let showInterrupt = false;
      let handled = false;
      if (st) {
        handled = true;
        let line;
        if (st.state === "restarting") line = "● Not connected - the link stopped responding, restarting this agent's session...";
        else if (st.state === "degraded") line = "● Link unreliable - automatic restart limit reached; messages go over the message channel when it is available";
        else {
          const wait = Math.max(0, Math.round(((st.nextRetryAt || 0) - Date.now()) / 1000));
          line = "● Not connected - reconnecting (attempt " + ((st.attempts || 0) + 1) + (wait ? ", next try in " + wait + "s" : ", trying now") + ")";
        }
        indEl.textContent = line;
        indEl.classList.remove("hidden");
        indEl.classList.add("conn-lost");
        const n = s ? s.sendQueue.length : 0;
        if (n && holding(p)) bannerText = n + " message" + (n > 1 ? "s" : "") + " waiting for reconnect - delivered automatically once the link is back.";
      } else {
        indEl.classList.remove("conn-lost");
        const lc = s && s.connLongCmd;
        if (lc) {
          const ms = Date.now() - lc.startedAt;
          const waiting = s.pendingSent.length || s.sendQueue.length;
          bannerText = s.connInterrupt
            ? "Interrupting the command (Esc)..."
            : "Running a long command (" + fmtSecs(ms) + ") - " + (waiting ? "your message is" : "any message you send is") + " queued until it ends.";
          showInterrupt = !s.connInterrupt;
        }
      }
      if (bannerText) {
        if (banner.dataset.text !== bannerText + "|" + showInterrupt) {
          banner.dataset.text = bannerText + "|" + showInterrupt;
          banner.textContent = "";
          const span = document.createElement("span");
          span.textContent = bannerText;
          banner.appendChild(span);
          if (showInterrupt) {
            const b = document.createElement("button");
            b.textContent = "Interrupt now (Esc) and deliver";
            b.title = "Sends Esc to this agent: the running command is stopped (nothing else is lost) and your message is delivered.";
            b.addEventListener("click", () => interrupt(p));
            banner.appendChild(b);
          }
        }
        banner.classList.remove("hidden");
      } else {
        banner.dataset.text = "";
        banner.classList.add("hidden");
      }
      return handled;
    } catch (e) { return false; }
  }

  function interrupt(p) {
    const s = sess(p);
    if (!s || s.connInterrupt) return;
    s.connInterrupt = { at: Date.now(), idleSince: null };
    window.api.logGuard("connection: user pressed Interrupt now on a long command for " + p);
    window.api.sendInput(p, "\x1b");
    paint(p, chatThinkingIndicatorEl);
  }

  async function deliverAfterInterrupt(p, s) {
    s.connInterrupt = null;
    s.connLongCmd = null;
    const left = s.pendingSent.filter((x) => !x.superseded).slice();
    for (const pending of left) {
      let holds = false;
      try { holds = await window.api.agentInputHoldsText(p, pending.text); } catch (e) {}
      if (!s.pendingSent.includes(pending)) continue; // matched meanwhile
      if (holds) { window.api.sendInput(p, "\r"); window.api.logGuard("connection: pressed Enter for a message left in the input box after Esc, " + p); continue; }
      s.pendingSent = s.pendingSent.filter((x) => x !== pending);
      window.api.logGuard("connection: re-sent a message that was not delivered after Esc, " + p);
      submitToAgent(p, pending.text);
    }
    paint(p, chatThinkingIndicatorEl);
  }

  // Called from rebuildChatView() with the activity it already fetched (no extra IPC, no extra timer).
  function onActivity(p, s, a) {
    try {
      if (!a) return;
      const isShell = a.working && a.pendingToolUse && /^(Bash|PowerShell)$/i.test(a.pendingToolName || "") && (a.pendingToolAgeMs || 0) > LONG_CMD_MS;
      if (isShell) {
        if (!s.connLongCmd) s.connLongCmd = { startedAt: Date.now() - a.pendingToolAgeMs };
      } else if (!s.connInterrupt) {
        s.connLongCmd = null;
      }
      const ci = s.connInterrupt;
      if (ci) {
        if (a.working) ci.idleSince = null;
        else if (ci.idleSince == null) ci.idleSince = Date.now();
        else if (Date.now() - ci.idleSince >= AFTER_INTERRUPT_WAIT_MS) deliverAfterInterrupt(p, s);
        if (Date.now() - ci.at > 90 * 1000) { s.connInterrupt = null; } // gave up waiting; the banner clears itself
      }
    } catch (e) { /* never break the chat */ }
  }

  window.connHealth = { holding, interceptSend, paint, onActivity, onState, _states: states };
  try {
    window.api.onConnectionState(onState);
    window.api.getConnectionStates().then((list) => (list || []).forEach(onState)).catch(() => {});
  } catch (e) { /* older preload: feature stays off */ }
})();

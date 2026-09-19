// Guards (v1.23.0) - loaded AFTER renderer.js, deliberately isolated: everything is
// inside try/catch and only talks to renderer.js through its existing globals
// (activeAgentPath, terminals, submitToAgent, performSessionReset, renderQueue), so a
// bug here can only disable the guards, never the chat.
//
//  1. Context banner: when this agent's live context passes CONTEXT_WARN_TOKENS, offer
//     "Save handoff & reset". Every message re-reads the whole context, so long
//     sessions are the main cost driver (see the Optimization agent's analysis).
//     Approved flow: agent writes lessons to memory + <agent>\handoff_latest.md ->
//     Agent Desktop archives that file -> the normal Reset Session sequence runs ->
//     the new session's first message points at the archived handoff. The Chat View
//     then shows a red "SESSION RESET" marker listing the lessons (see archive.js).
//  2. Limit banner: 80/90/95% and at-the-limit warnings inside the chat (OS
//     notifications for the same thresholds come from guards-main.js).
(function () {
  "use strict";
  const CONTEXT_WARN_TOKENS = 150000;
  const REDISMISS_GROWTH_TOKENS = 25000;
  const HANDOFF_TIMEOUT_MS = 12 * 60 * 1000;
  const TICK_MS = 10000;
  const FLOW_POLL_MS = 3000;
  const RESUME_MARKER = "[[HANDOFF-RESUME]]";
  const RESUME_SETTLE_MS = 5000; // let a freshly attached session settle before typing into it
  const RESUME_VERIFY_MS = 30000; // how long to wait for the message to show up in the transcript

  const flows = new Map(); // agentPath -> { phase, startedAt, error, quietPolls }
  const pendingResume = new Map(); // agentPath -> { text, path, readySince, sentAt, tries }
  const dismissedAt = new Map(); // agentPath -> token count when "Later" was clicked
  const resetAt = new Map(); // agentPath -> ms time of our last handoff reset
  // Also used by renderer.js's header "% context" pill (same stale-usage problem).
  window.guardUsageIsStale = (ap, usage) => !!(usage && usage.timestamp && resetAt.has(ap) && new Date(usage.timestamp).getTime() < resetAt.get(ap));
  let ctxTokens = null;

  function el(id, cls) {
    const d = document.createElement("div");
    d.id = id;
    d.className = "guard-banner hidden " + (cls || "");
    return d;
  }

  const chatView = document.getElementById("chat-view");
  const chatBody = document.getElementById("chat-body");
  if (!chatView || !chatBody) return;
  const limitBanner = el("guard-limit-banner");
  const ctxBanner = el("guard-context-banner");
  chatView.insertBefore(limitBanner, chatBody);
  chatView.insertBefore(ctxBanner, chatBody);

  const headerBtn = document.createElement("button");
  headerBtn.id = "handoff-reset-btn";
  headerBtn.textContent = "Handoff & reset";
  headerBtn.title = "Ask the agent to save lessons to memory and write a handoff file, then reset the session and resume from that handoff (cuts the cost of long conversations)";
  const resetBtn = document.getElementById("reset-session-btn");
  if (resetBtn && resetBtn.parentNode) resetBtn.parentNode.insertBefore(headerBtn, resetBtn);
  headerBtn.addEventListener("click", () => startFlow(activeAgentPath, true));

  function handoffPrompt(agentPath) {
    const file = agentPath.replace(/[\\/]+$/, "") + "\\handoff_latest.md";
    return (
      "[Agent Desktop - planned context reset] Iddo approved resetting this session to cut usage. " +
      "Before it happens, please do ALL of this now, without starting any new work:\n" +
      "1. Compile a 'lessons for the future' list from this session (gotchas + fixes, preferences/decisions Iddo stated, environment quirks) and save each durable one into your memory files per your memory rules.\n" +
      "2. Update your open-items file (OPEN NOW) so it reflects what is still outstanding.\n" +
      "3. Write the file " + file + " with exactly these sections: '# Handoff <date/time>', '## LESSONS' (concise bullets - this section is shown to Iddo), '## OPEN NOW', '## STATE' (what you were in the middle of, key file paths, the exact next step), '## KEY FACTS' (anything else a fresh session needs). Keep it under ~1500 words; write it LAST, after steps 1-2.\n" +
      "4. Reply with only the LESSONS list and the words 'Handoff saved'."
    );
  }

  function resumePrompt(archivedPath) {
    return (
      "[[HANDOFF-RESUME]] " + archivedPath + "\n" +
      "This is a fresh session after a planned context reset. Read that handoff file first, then reply in two short lines: what you are picking up, and your very next step. Continue with that step unless it needs my approval."
    );
  }

  function queueOrSend(agentPath, text) {
    const session = terminals.get(agentPath);
    if (session && (session.busy || !session.started)) {
      session.sendQueue.push(text);
      if (typeof renderQueue === "function") renderQueue(agentPath);
    } else {
      submitToAgent(agentPath, text);
    }
  }

  async function startFlow(agentPath, confirmFirst) {
    try {
      if (!agentPath || flows.has(agentPath)) return;
      if (confirmFirst && !confirm("Ask this agent to save its lessons + a handoff file, then reset the session and resume from the handoff?")) return;
      const flow = { phase: "saving", startedAt: Date.now(), error: null, quietPolls: 0 };
      flows.set(agentPath, flow);
      queueOrSend(agentPath, handoffPrompt(agentPath));
      render();
      flow.timer = setInterval(() => advanceFlow(agentPath), FLOW_POLL_MS);
    } catch (e) {
      console.error("guards startFlow", e);
    }
  }

  async function advanceFlow(agentPath) {
    const flow = flows.get(agentPath);
    if (!flow || flow.phase !== "saving") return;
    try {
      // Time spent stopped on a usage limit does not count: the agent cannot write anything then.
      const lim = await window.api.getLimitStatus(agentPath).catch(() => null);
      if (lim && lim.halt) flow.pausedMs = (flow.pausedMs || 0) + FLOW_POLL_MS;
      if (Date.now() - flow.startedAt - (flow.pausedMs || 0) > HANDOFF_TIMEOUT_MS) {
        const ex = await window.api.getHandoffInfo(agentPath);
        flow.canUseExisting = !!(ex && ex.exists);
        flow.phase = "failed";
        flow.error =
          "The agent did not finish the handoff within 12 minutes - nothing was reset." +
          (flow.canUseExisting ? " A handoff_latest.md already exists; if it is the one you want, use the button to reset with it." : "");
        clearInterval(flow.timer);
        render();
        return;
      }
      const session = terminals.get(agentPath);
      const info = await window.api.getHandoffInfo(agentPath);
      const fresh = info && info.exists && info.mtimeMs > flow.startedAt;
      const idle = session && !session.busy && !(session.sendQueue && session.sendQueue.length);
      flow.quietPolls = fresh && idle ? flow.quietPolls + 1 : 0;
      // v1.24.3: the agent can finish its turn and even say "Handoff saved" WITHOUT writing the file
      // (Product Development, 2026-09-19: answered from an older handoff with zero tool calls, so the
      // flow sat until the 12-minute timeout). If it has been idle and the file is still not fresh,
      // tell it plainly, at most twice, instead of waiting out the clock.
      flow.idleStalePolls = idle && !fresh ? (flow.idleStalePolls || 0) + 1 : 0;
      if (flow.idleStalePolls >= 3 && (flow.nudges || 0) < 2) {
        flow.nudges = (flow.nudges || 0) + 1;
        flow.idleStalePolls = 0;
        const fileP = agentPath.replace(/[\\/]+$/, "") + "\\handoff_latest.md";
        const last = info && info.exists ? new Date(info.mtimeMs).toLocaleTimeString() : "never";
        submitToAgent(
          agentPath,
          "[Agent Desktop] Your last reply said the handoff was saved, but " + fileP + " has NOT been rewritten since this request (file last modified: " + last + "). " +
            "Do not answer from memory. Use a tool to write that exact file now with the sections requested (# Handoff, ## LESSONS, ## OPEN NOW, ## STATE, ## KEY FACTS); if the Write tool fails, write it with a Bash heredoc or a Python script. Then reply with only 'Handoff saved'."
        );
        return;
      }
      if (flow.quietPolls < 2) return; // handoff written AND agent idle for two polls in a row
      await runReset(agentPath, flow);
    } catch (e) {
      flow.phase = "failed";
      flow.error = "Handoff/reset stopped: " + e.message;
      clearInterval(flow.timer);
      render();
    }
  }

  // Archive the handoff, swap in a fresh session (performSessionReset no longer types /clear - see
  // its comment in renderer.js), then hand the resume message to tickResume(), which delivers it
  // and VERIFIES it reached the transcript (the old flow "succeeded" while the message was lost).
  async function runReset(agentPath, flow) {
    flow.phase = "resetting";
    clearInterval(flow.timer);
    render();
    const arch = await window.api.archiveHandoff(agentPath);
    if (!arch || !arch.ok) throw new Error((arch && arch.error) || "could not archive handoff");
    resetAt.set(agentPath, Date.now());
    await performSessionReset(agentPath);
    pendingResume.set(agentPath, { text: resumePrompt(arch.path), path: arch.path, readySince: null, sentAt: null, tries: 0 });
    flow.phase = "resuming";
    render();
  }

  // Runs every 2s. For each pending resume: wait until the fresh session is attached (it only
  // attaches once the agent is opened), give it a few seconds to settle, send, then confirm the
  // marker landed in the transcript. Resend once if not; after that tell the user what to do.
  async function tickResume() {
    for (const [ap, r] of Array.from(pendingResume.entries())) {
      try {
        const flow = flows.get(ap);
        const s = terminals.get(ap);
        if (!s || !s.started) {
          r.readySince = null;
          continue;
        }
        if (!r.readySince) r.readySince = Date.now();
        if (!r.sentAt) {
          if (Date.now() - r.readySince < RESUME_SETTLE_MS || s.busy) continue;
          r.sentAt = Date.now();
          r.tries++;
          submitToAgent(ap, r.text);
          continue;
        }
        if (await window.api.transcriptHas(ap, RESUME_MARKER)) {
          pendingResume.delete(ap);
          if (flow) {
            flow.phase = "done";
            render();
            setTimeout(() => {
              flows.delete(ap);
              render();
            }, 8000);
          }
        } else if (Date.now() - r.sentAt > RESUME_VERIFY_MS) {
          if (r.tries < 2) {
            r.sentAt = null; // not received - send it again
            r.readySince = Date.now();
          } else {
            pendingResume.delete(ap);
            if (flow) {
              flow.phase = "failed";
              flow.error = "The fresh session did not receive the resume message. Send it this line yourself: Read " + r.path + " and continue from there.";
              render();
            }
          }
        }
      } catch (e) {
        console.error("guards tickResume", e);
      }
    }
  }
  setInterval(tickResume, 2000);

  function fmtReset(sec) {
    if (!sec) return "";
    const d = new Date(sec > 1e12 ? sec : sec * 1000);
    const mins = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
    const left = mins >= 60 ? Math.floor(mins / 60) + "h " + (mins % 60) + "m" : mins + "m";
    return " - resets " + d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + " (in " + left + ")";
  }

  function show(box, cls, html, buttons) {
    box.className = "guard-banner " + cls;
    box.textContent = "";
    const span = document.createElement("span");
    span.className = "guard-text";
    span.textContent = html;
    box.appendChild(span);
    for (const b of buttons || []) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.addEventListener("click", b.onClick);
      box.appendChild(btn);
    }
  }

  let lastLimit = null;
  function render() {
    try {
      const ap = activeAgentPath;
      // --- limit banner
      if (!ap || !lastLimit) {
        limitBanner.className = "guard-banner hidden";
      } else if (lastLimit.halt) {
        const t = lastLimit.halt.resetsAt ? " - resets around " + new Date(lastLimit.halt.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ", then this agent auto-continues" : "";
        show(limitBanner, "guard-red", "STOPPED - Claude " + (lastLimit.halt.rateLimitType || "usage") + " limit reached" + t, []);
      } else {
        const parts = [];
        let worst = 0;
        for (const [k, label] of [["fiveHour", "5-hour"], ["sevenDay", "weekly"]]) {
          const w = lastLimit[k];
          if (w && typeof w.usedPct === "number" && w.usedPct >= 80) {
            parts.push(label + " usage " + Math.round(w.usedPct) + "%" + fmtReset(w.resetsAt));
            worst = Math.max(worst, w.usedPct);
          }
        }
        if (parts.length) show(limitBanner, worst >= 95 ? "guard-red" : "guard-amber", "Approaching the limit: " + parts.join("  |  "), []);
        else limitBanner.className = "guard-banner hidden";
      }

      // --- context / handoff banner
      const flow = ap && flows.get(ap);
      if (flow) {
        if (flow.phase === "saving") show(ctxBanner, "guard-blue", "Handoff in progress: the agent is saving lessons to memory and writing handoff_latest.md - the reset happens automatically when it finishes (lessons appear in its reply).", []);
        else if (flow.phase === "resetting") show(ctxBanner, "guard-blue", "Handoff saved - starting a fresh session now...", []);
        else if (flow.phase === "resuming") show(ctxBanner, "guard-blue", "Fresh session started - sending it the handoff and confirming it arrived (if this agent was not open, this happens as soon as you open it).", []);
        else if (flow.phase === "done") show(ctxBanner, "guard-green", "Reset done and confirmed: the new session received the handoff and is reading it; the red marker above lists the lessons carried over.", []);
        else {
          const btns = [{ label: "Dismiss", onClick: () => { flows.delete(ap); pendingResume.delete(ap); render(); } }];
          // The handoff file may exist already (e.g. it was written before a retry click, or after a timeout):
          // let the user reset using it instead of making the agent write it again.
          if (flow.canUseExisting) {
            btns.unshift({
              label: "Reset using the existing handoff",
              onClick: async () => {
                try {
                  flow.canUseExisting = false;
                  await runReset(ap, flow);
                } catch (e) {
                  flow.phase = "failed";
                  flow.error = "Handoff/reset stopped: " + e.message;
                  render();
                }
              },
            });
          }
          show(ctxBanner, "guard-red", flow.error || "Handoff failed.", btns);
        }
      } else if (ap && ctxTokens !== null && ctxTokens >= CONTEXT_WARN_TOKENS && !(dismissedAt.has(ap) && ctxTokens < dismissedAt.get(ap) + REDISMISS_GROWTH_TOKENS)) {
        show(
          ctxBanner,
          "guard-amber",
          "This conversation is " + Math.round(ctxTokens / 1000) + "K tokens - every message re-reads all of it, so it costs far more than a fresh session. A handoff reset (lessons saved to memory first) typically saves ~30-40% of this agent's usage.",
          [
            { label: "Save handoff & reset", onClick: () => startFlow(ap, false) },
            { label: "Later", onClick: () => { dismissedAt.set(ap, ctxTokens); render(); } },
          ]
        );
      } else {
        ctxBanner.className = "guard-banner hidden";
      }
    } catch (e) {
      console.error("guards render", e);
    }
  }

  async function tick() {
    try {
      const ap = activeAgentPath;
      if (!ap) {
        lastLimit = null;
        ctxTokens = null;
        render();
        return;
      }
      const [usage, lim] = await Promise.all([window.api.getContextUsage(ap), window.api.getLimitStatus(ap)]);
      if (ap !== activeAgentPath) return;
      ctxTokens = usage && typeof usage.contextTokens === "number" ? usage.contextTokens : null;
      // After a reset the newest assistant entry on disk is still the OLD session's until the
      // new session replies - ignore any usage stamped before the reset (stale 204K banner bug).
      if (ctxTokens !== null && window.guardUsageIsStale(ap, usage)) ctxTokens = null;
      lastLimit = lim;
      render();
    } catch (e) {
      console.error("guards tick", e);
    }
  }
  setInterval(tick, TICK_MS);
  setTimeout(tick, 1500);
  // Re-check right away when the user switches agents (activeAgentPath changes).
  let lastAgent = null;
  setInterval(() => {
    if (activeAgentPath !== lastAgent) {
      lastAgent = activeAgentPath;
      ctxTokens = null;
      lastLimit = null;
      render();
      tick();
    }
  }, 500);
})();

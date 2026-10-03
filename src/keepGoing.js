// v1.69.0: "Keep going" - agents must not stop mid-work. Pure, unit-tested decision logic (tests/keepGoing.test.js).
// Works in node (main, tests) and as a plain <script> in the renderer (window.KeepGoing, for the nudge label).
//
// Problem (Iddo, 2026-10-03): agents end a turn with "next: do X" / "I'll now ..." and stop although nothing blocks
// them; after a handoff reset they sit idle instead of continuing. This module answers ONE question for an agent
// that is idle: should it get a nudge? Verdicts: "nudge" | "blocked" | "done" | "none".
//
// Protocol agents can use (honoured exactly, no guessing): a final line `BLOCKED: <reason>` or `DONE: <summary>`.
// No I/O here: transcript lines, throttle state and clocks are passed in, so everything is deterministic.
(function (root) {
  "use strict";

  const NUDGE_MARKER = "[[KEEPGOING]]";
  const RESUME_MARKER = "[[HANDOFF-RESUME]]";
  const NUDGE_TEXT =
    NUDGE_MARKER + " You ended your last turn announcing a next step without doing it. If it is a step you can do yourself right now, do it in this turn with tool calls and keep going until the task is finished. " +
    "If you need approval (from Iddo or anyone else), are waiting on a background job or another agent, or are done, end your reply with a line 'BLOCKED: <reason>' or 'DONE: <summary>' instead, and do not take any action that needs approval.";

  const LIMITS = {
    quietMs: 20 * 1000,            // the last entry must be this old (the agent may be about to continue by itself)
    humanQuietMs: 60 * 1000,       // a human typed within this: leave the agent alone
    maxAgeMs: 3 * 60 * 60 * 1000,  // an end-of-turn older than this is stale (app restart must not wake the whole fleet)
    minGapMs: 90 * 1000,           // between two nudges to the same agent
    maxConsecutive: 3,             // without a new human message or real progress (tool calls after a nudge)
    windowMs: 2 * 60 * 60 * 1000,  // hard ceiling even with progress: at most maxPerWindow nudges per agent per window
    maxPerWindow: 10,
    globalGapMs: 20 * 1000,        // between two nudges to ANY agents (no fleet-wide burst)
    missionMaxAgeMs: 24 * 60 * 60 * 1000,
    warmupMs: 5 * 60 * 1000,       // after the app starts: do not judge anybody for this long (no burst of stale nudges)
    retryAfterMs: 3 * 60 * 1000,   // a nudge that never landed is retried after this (max 2 retries)
  };

  const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "ToolSearch", "TodoWrite", "TaskList", "TaskGet"]);
  const WAIT_TOOLS = new Set(["SendMessage", "ScheduleWakeup", "Monitor", "CronCreate"]);
  const NON_HUMAN_PREFIX = /^\s*(<task-notification|<system-reminder|\[Message from|<command-|<local-command|<cross-session)/i;

  // ---------------------------------------------------------------- transcript tail
  function textOf(content) {
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    const out = [];
    for (const b of content) if (b && b.type === "text" && b.text) out.push(String(b.text).trim());
    return out.join("\n\n").trim();
  }

  function stripMarkers(t) {
    return String(t || "").replace(/^\s*(\[hid:[^\]]*\]\s*)+/, "").trim();
  }
  // Messages this app (or a peer relay) sent, not typed by a person.
  function isSystemish(t) {
    const s = stripMarkers(t);
    return s.indexOf(NUDGE_MARKER) !== -1 && s.indexOf(NUDGE_MARKER) < 40 ||
      s.indexOf(RESUME_MARKER) !== -1 && s.indexOf(RESUME_MARKER) < 40 ||
      s.indexOf("[Agent Desktop") === 0 ||
      isHandoffPrompt(s);
  }
  function isHandoffPrompt(t) {
    const s = String(t || "");
    return s.indexOf("handoff_latest.md") !== -1 && (/Handoff saved/i.test(s) || /still not written/i.test(s));
  }

  // lines: transcript JSONL lines (the tail). Returns the facts the decision needs.
  function parseTail(rawText, partialFirst) {
    let lines = String(rawText || "").split("\n");
    if (partialFirst) lines = lines.slice(1); // the tail cut landed mid-line
    const entries = [];
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      let o;
      try { o = JSON.parse(l); } catch (e) { continue; }
      if (!o || (o.type !== "user" && o.type !== "assistant") || o.isSidechain || o.isMeta || !o.message) continue;
      const ts = o.timestamp ? new Date(o.timestamp).getTime() : NaN;
      const c = o.message.content;
      const blocks = Array.isArray(c) ? c : [];
      const tools = blocks.filter((b) => b && b.type === "tool_use");
      entries.push({
        role: o.type,
        ts: Number.isFinite(ts) ? ts : 0,
        text: textOf(c),
        toolUse: tools.length > 0,
        // a tool call that is real work (not just reading) / one that means "waiting on something else"
        workTool: tools.some((b) => !READ_ONLY_TOOLS.has(String(b.name || ""))),
        waitTool: tools.some((b) => WAIT_TOOLS.has(String(b.name || "")) || (b.input && (b.input.run_in_background === true || b.input.run_in_background === "true"))),
        toolResult: blocks.some((b) => b && b.type === "tool_result"),
        apiError: !!o.isApiErrorMessage,
        originKind: o.origin && o.origin.kind ? String(o.origin.kind) : null,
      });
    }
    const last = entries.length ? entries[entries.length - 1] : null;
    let lastHuman = null, hi = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.role === "user" && !e.toolResult && e.text) { hi = i; break; }
    }
    if (hi >= 0) {
      const e = entries[hi];
      const s = stripMarkers(e.text);
      lastHuman = {
        ts: e.ts, text: e.text,
        isNudge: s.indexOf(NUDGE_MARKER) !== -1 && s.indexOf(NUDGE_MARKER) < 40,
        isResume: s.indexOf(RESUME_MARKER) !== -1 && s.indexOf(RESUME_MARKER) < 40,
        // systemish = NOT a genuine person: this app's markers, task notifications, hook/system-reminder injections, peer relays,
        // or any entry whose transcript origin is not "human" (M2: only a real person's message resets the counters)
        systemish: isSystemish(e.text) || (e.originKind != null && e.originKind !== "human") || NON_HUMAN_PREFIX.test(stripMarkers(e.text)),
      };
    }
    let turnToolUses = 0, workToolUses = 0, turnWaits = false;
    for (let i = hi + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e.role !== "assistant") continue;
      if (e.toolUse) turnToolUses++;
      if (e.workTool) workToolUses++;
      if (e.waitTool) turnWaits = true;
    }
    return { last, lastHuman, turnToolUses, workToolUses, turnWaits, entryCount: entries.length };
  }

  // ---------------------------------------------------------------- text classification
  function nonEmptyLines(text) {
    return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  function plainLine(l) { return l.replace(/^[\s>*_#`~\-•]+/, "").replace(/[*_`~]+/g, "").trim(); }

  // Honoured exactly: one of the last 3 non-empty lines starts with BLOCKED: / DONE:
  function protocolOf(text) {
    const ls = nonEmptyLines(text).slice(-3);
    for (let i = ls.length - 1; i >= 0; i--) {
      const p = plainLine(ls[i]);
      let m = /^BLOCKED\s*[:\-–—]\s*(.*)$/.exec(p);
      if (m) return { kind: "blocked", reason: m[1].slice(0, 200) };
      m = /^DONE\s*[:\-–—]\s*(.*)$/.exec(p);
      if (m) return { kind: "done", reason: m[1].slice(0, 200) };
    }
    return null;
  }

  function lastParagraph(text) {
    const paras = String(text || "").trim().split(/\n\s*\n/);
    let p = paras[paras.length - 1] || "";
    if (p.length < 25 && paras.length > 1) p = paras[paras.length - 2] + "\n\n" + p; // a one-line sign-off
    return p.trim();
  }

  const RX = {
    // the agent waits on / asks somebody
    wait: /\b(want me to|would you like|do you want|shall i|should i|let me know|tell me (if|when|which|what|whether)|need(s|ed)? (your|iddo'?s|a|an|the)? ?(ok|okay|decision|go-?ahead|approval|input|answer|confirmation|permission|sign-?off|reply)|waiting (for|on)|awaiting|please (confirm|approve|advise|decide|choose|reply|let)|your (call|decision|ok|approval|go-?ahead|choice|input)|up to you|once you (confirm|approve|reply|say|tell)|if you (approve|confirm|agree|want|like|prefer|need|say)|pending (your|iddo'?s|approval)|before i (proceed|continue|go on)|i'?ll (wait|stand by|hold|pause|stop here)|standing by|stopping here|i('| a)m paused|paused until)\b/i,
    // work that belongs to Iddo / another agent / a human
    others: /\b(iddo|you) (should|needs? to|must|will need to|has to|have to|to (approve|decide|confirm|review|choose|run|click|open|restart|log ?in|enter|sign|pay|check))\b|\bfor iddo\b|\b(needs?|requires?) (iddo|a human|manual|your|his)\b|\b(ask|asked|asking|message[d]?|sent a message to|reply from|answer from|response from|waiting for the) (iddo|the coo|the [a-z][\w &-]* agent)\b|\biddo-only\b|\bhand(ed|ing)? (it )?(back|over|off) to (iddo|the coo)\b|\bblocked (on|by)\b|\bcan'?t (proceed|continue) (until|without)\b/i,
    // throttle / limits
    limit: /\b(fleet ?throttle|throttle)\b[^.\n]{0,40}\bhold\b|\b(rate|usage|weekly|5-?hour) limit\b|\btoken budget\b[^.\n]{0,40}\b(exhausted|reached|hit)\b/i,
    // genuinely nothing left
    strongDone: /\bnothing (is )?(left|else|more|further|remaining|open|pending|outstanding)( to do)?\b|\bbacklog (is )?(now )?(empty|clear|done)\b|\bno (more |further |remaining |other )?(open|pending|outstanding|unblocked) (tasks?|items?|work)\b|\bno open tasks\b|\b(all|every)\b[^.\n]{0,50}\b(tasks?|items?|work|steps?|todos?)\b[^.\n]{0,30}\b(is|are|now|were|have been)? ?(done|complete[d]?|finished|closed)\b|\b(that|this) (completes|wraps up|finishes|concludes)\b|\bwork is (all |now |fully )?(done|complete[d]?|finished)\b|\beverything (is |has been )?(done|complete[d]?|finished)\b/i,
    weakDone: /\b(task|job|work|fix|migration|build|feature)( is| was| has been)? (complete[d]?|finished|done)\b|\ball done\b|\bfinished\b[.!]?\s*$/i,
    // H1: the agent is legitimately waiting (background job, another agent, a later time, approval, a report/summary): never nudge
    waiting: /\bin the background\b|\brun_in_background\b|\bbackground (job|task|process|render|run)\b|\bwhen (it|they|that|this|the [\w -]{1,30}) (finish|finishes|completes?|is done|are done|ends|lands|returns)\b|\bonce (it|they|that|this|the [\w -]{1,30}) (finish|finishes|completes?|is done|are done|replies|reply|answers?|responds?|lands|returns)\b|\b(check|checking) (back|in|on it|on them|again)\b|\bcheck (it|them) (later|when|once|after)\b|\bmonitor(ing)?\b|\b(i'?ll|i will) (pick (it|this|that|up)|continue|resume|proceed) (up )?(once|when|after)\b|\bcontinue once\b|\b(they|he|she) (answer|reply|respond)s?\b|\b(after|once|when) you\b|\bsay (go|yes|ok|okay|\"go\"|'go')\b|\bgo-?ahead\b|\bapprov(al|e|ed|es)\b|\byour (ok|okay|word|say)\b|\bif you (approve|agree|confirm)\b|\btomorrow\b|\bin \d+ ?(min|mins|minutes|hours?|h|days?)\b|\blater\b|\btonight\b|\bnext steps? (for|of|from|to be taken by)\b|\blet me (summari[sz]e|explain|know|clarify|recap|walk|say)\b|\b(to|in) (summary|summari[sz]e|recap)\b/i,
    // externally visible / irreversible actions: a nudge must never push an agent into one (approval rules live elsewhere)
    external: /\b(push(ing)?|publish(ing)?|send(ing)?|e-?mail(ing)?|deploy(ing)?|delet(e|ing)|merg(e|ing)|releas(e|ing)|submit(ting)?|pay(ing)?|purchas(e|ing))\b/i,
    // a concrete first-person next action (tested against the LAST sentence(s) only)
    announce: /(^|\n|[.!]\s+)[\s>*_\-•#]*(next( up)?|now|then|up next|after that|immediately)[\s*_]*[:–—]\s*\S|(^|\n|[.!]\s+)[\s>*_\-•#]*next,\s+[a-z]{3,}|(^|\n|[.!]\s+)[\s>*_\-•#]*(now|then),?\s+(i\b|let|running|starting|updating|checking|writing|building|fixing|adding|creating|reading|testing|installing|regenerating|rebuilding|wiring|moving|merging|[a-z]{3,}ing\b)|(^|\n|[.!]\s+)[\s>*_\-•#]*(starting|beginning|proceeding|continuing|moving on)\b|\bnext steps?\s*:\s*\S|\b(i'?ll|i will|i'?m going to|i am going to|i'?m about to|we'?re going to|i'?m now|i am now|now i'?ll|now i will|now i'?m|then i'?ll|then i will|next i'?ll|next,? i)\b|\b(starting|beginning|proceeding|continuing|moving on) (with|to|by)\b|\bnow (let me|let's|to)\b|\blet me\b(?! (know|summari|explain|clarify|recap|walk|say))|\blet'?s (now |next )?(go|do|run|start|move|fix|build|write|check|try|get)\b|\bgoing to (now |next )?(run|start|fix|build|write|check|try|do|add|create|update|test|implement|read|look)\b/i,
  };

  // the last one or two sentences / lines of the message: the announcement must be there, not in the middle of a report
  function tailSentences(text) {
    const para = lastParagraph(text);
    const parts = para.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
    return parts.slice(-2).join("\n");
  }

  // verdict: "nudge" (announces a next action, nobody waits) | "blocked" | "done" | "none"
  function classify(text) {
    const t = String(text || "").trim();
    if (!t) return { verdict: "none", reason: "empty message" };
    const proto = protocolOf(t);
    if (proto) return { verdict: proto.kind, reason: "protocol line " + proto.kind.toUpperCase() + ": " + proto.reason };
    const win = t.slice(-800);
    const para = lastParagraph(t);
    const lastLine = plainLine(nonEmptyLines(t).slice(-1)[0] || "").replace(/["')\]}”’\s]+$/, "");
    if (/\?$/.test(lastLine)) return { verdict: "blocked", reason: "ends with a question" };
    if (RX.others.test(win)) return { verdict: "blocked", reason: "next step belongs to Iddo / another agent" };
    if (RX.limit.test(win)) return { verdict: "blocked", reason: "throttle or usage limit mentioned" };
    if (/\bBLOCKED\b/.test(win) || /\bON HOLD\b/.test(win)) return { verdict: "blocked", reason: "says BLOCKED" };
    if (RX.strongDone.test(win)) return { verdict: "done", reason: "says nothing is left" };
    if (RX.wait.test(para)) return { verdict: "blocked", reason: "waits for / asks someone" };
    const tailS = tailSentences(t);
    if (RX.announce.test(tailS)) {
      if (RX.waiting.test(para)) return { verdict: "blocked", reason: "waiting on a background job, another agent, a later time or approval" };
      if (RX.external.test(tailS)) return { verdict: "none", reason: "announced action is externally visible (push/send/publish...): never nudged" };
      return { verdict: "nudge", reason: "announces a next action" };
    }
    if (RX.weakDone.test(win)) return { verdict: "done", reason: "says finished" };
    return { verdict: "none", reason: "no announced next step" };
  }

  // ---------------------------------------------------------------- handoff file
  function sectionOf(text, heading) {
    const m = new RegExp("^##\\s+" + heading + "\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))", "mi").exec(String(text || ""));
    return m ? m[1].trim() : "";
  }
  function meaningful(s) {
    const lines = nonEmptyLines(s).map(plainLine).filter(Boolean);
    return lines.some((l) => !/^(none|nothing|n\/a|na|-+|\(none\)|nothing open|no open (items|tasks)|empty|tbd)\.?$/i.test(l));
  }
  // { openNow, nextStep, blocked, blockedReason, mission }: mission = there is work to continue and nothing declares BLOCKED.
  function parseHandoff(text) {
    const t = String(text || "");
    const openNow = sectionOf(t, "OPEN NOW");
    const state = sectionOf(t, "STATE");
    let nextStep = "";
    const m = /exact next step[^\n:]*[:\-]?\s*([^\n]*(?:\n(?![#\n])[^\n]*)?)/i.exec(state) || /exact next step[^\n:]*[:\-]?\s*([^\n]*)/i.exec(t);
    if (m) nextStep = m[1].replace(/[*_`]/g, "").trim();
    let blocked = false, blockedReason = "";
    for (const part of [openNow, state]) {
      for (const l of nonEmptyLines(part)) {
        const b = /^BLOCKED\s*[:\-–—]\s*(.*)$/.exec(plainLine(l));
        if (b) { blocked = true; blockedReason = b[1].slice(0, 200); }
      }
    }
    const WAITY = /\bwaiting (for|on)\b|\bawaiting\b|\bneeds? (iddo|approval|his|your|a decision)\b|\b(iddo'?s|his|your) (go|ok|okay|approval|decision|answer|call)\b|\bapproval\b|\bgo-?ahead\b|\bon hold\b|\bblocked\b|\bonce (iddo|he|you|they|the [\w -]{1,30}) (approve|confirm|answer|reply|decide|say)/i;
    const workItems = nonEmptyLines(openNow).map(plainLine).filter((l) => l && meaningful(l) && !WAITY.test(l));
    const hasWork = workItems.length > 0 || !!(nextStep && meaningful(nextStep) && !WAITY.test(nextStep));
    const doneDeclared = /^DONE\s*[:\-]/mi.test(openNow);
    return { openNow, nextStep, blocked, blockedReason, mission: !!(hasWork && !blocked && !doneDeclared) };
  }

  // The message the fresh session gets after a handoff reset (keeps the RESUME marker the renderer verifies).
  function resumePromptText(archivedPath, info) {
    if (info && info.mission) {
      return RESUME_MARKER + " " + archivedPath + "\n" +
        "This is a fresh session after a planned context reset. Read that handoff file, then continue IMMEDIATELY with its exact next step, using tool calls. " +
        "Do not recap, and do not wait for confirmation unless that step needs approval from Iddo or someone else. Keep going until the task is finished. " +
        "If the step needs approval, waits on a background job or another agent, or the fleet throttle is HOLD, reply with a line 'BLOCKED: <reason>' and take no action that needs approval; if nothing is left, 'DONE: <summary>'.";
    }
    return RESUME_MARKER + " " + archivedPath + "\n" +
      "This is a fresh session after a planned context reset. Read that handoff file first, then reply in two short lines: what you are picking up, and your very next step. Continue with that step unless it needs my approval.";
  }

  // ---------------------------------------------------------------- the decision
  // c: { now, enabled, paused, working, halt (getHaltInfo result|null), parsed (parseTail result), throttle ("GO"|"SLOW"|"HOLD"|null),
  //      mission ({active, since, firstTurnDone}|null) }
  // Returns { verdict, reason, defer? } - defer: would nudge later (settling / human typing), re-check without waiting for new transcript data.
  function decide(c) {
    const none = (reason, extra) => Object.assign({ verdict: "none", reason }, extra || {});
    if (!c.enabled) return none("keep-going is off");
    if (c.paused) return none("agent is paused");
    if (c.working) return none("agent is working");
    if (c.halt) return none("halted by " + (c.halt.kind || "an API error") + " (existing halt handling owns it)");
    const p = c.parsed;
    if (!p || !p.last) return none("no transcript yet");
    const last = p.last;
    if (last.role !== "assistant") return none("last entry is not an assistant reply");
    if (last.apiError) return none("last entry is an API error");
    if (last.toolUse) return none("last entry is a tool call (still working)");
    const text = last.text;
    if (/^\s*Handoff saved\b/i.test(text) || (p.lastHuman && isHandoffPrompt(p.lastHuman.text))) return none("handoff turn");
    const age = c.now - last.ts;
    if (age > LIMITS.maxAgeMs) return none("end of turn is stale (" + Math.round(age / 60000) + " min old)");
    const proto = protocolOf(text);
    if (proto) return { verdict: proto.kind, reason: "protocol line " + proto.kind.toUpperCase() + ": " + proto.reason };
    if (p.turnWaits) return none("this turn started a background task / messaged another agent / scheduled a wake-up: it is waiting, not stalled");
    const h = p.lastHuman;
    const missionOn = !!(c.mission && c.mission.active && !c.mission.firstTurnDone && h && h.isResume && p.workToolUses === 0 &&
      c.now - (c.mission.since || 0) < LIMITS.missionMaxAgeMs);
    let cls = classify(text);
    if (cls.verdict === "none" && missionOn && text) cls = { verdict: "nudge", reason: "fresh session after handoff ended its first turn without doing work" };
    else if (cls.verdict === "nudge" && missionOn) cls.reason += " (first turn after handoff, no work done)";
    if (cls.verdict !== "nudge") return cls;
    if (age < LIMITS.quietMs) return none("settling", { defer: true });
    if (h && !h.systemish && c.now - h.ts < LIMITS.humanQuietMs) return none("a person typed " + Math.round((c.now - h.ts) / 1000) + " s ago", { defer: true });
    if (c.throttle === "HOLD") return { verdict: "blocked", reason: "fleet throttle is HOLD" };
    return { verdict: "nudge", reason: cls.reason, mission: missionOn };
  }

  function hashText(s) {
    let h = 5381;
    const t = String(s || "").slice(-400);
    for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return h.toString(36) + ":" + t.length;
  }

  // Label for the chat bubble of a nudge ("[hid:..] [[KEEPGOING]] ..."), or null.
  function nudgeLabelFor(text) {
    const t = String(text || "");
    const i = t.indexOf(NUDGE_MARKER);
    return i !== -1 && i < 40 ? "Keep going - nudge: you announced a next step, please do it now" : null;
  }

  const api = { READ_ONLY_TOOLS, NUDGE_MARKER, RESUME_MARKER, NUDGE_TEXT, LIMITS, parseTail, classify, protocolOf, decide, hashText, parseHandoff, resumePromptText,
    isSystemish, isHandoffPrompt, nudgeLabelFor, stripMarkers };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.KeepGoing = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

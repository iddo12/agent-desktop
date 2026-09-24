// Untrusted-agent banner (v1.54.0).
//
// Claude Code 2.1.281 refuses to run `claude --bg` in a folder whose
// workspace-trust prompt was never accepted; under this app's pty it just
// waits on the prompt. main.js now catches that prompt as it is drawn, keeps a
// list of the agents it blocks (untrustedAgents) and sends it here. This file
// draws:
//   - a banner across the top of the main panel, visible in every view
//     (chat, ARGUS, Library) and never covered once the startup overlay is
//     gone: "3 agents can't start until you trust their folders once ...
//     [Trust and start them]";
//   - the same message and button inside an untrusted agent's own chat pane,
//     so opening it explains itself instead of hanging silently.
//
// Trust is Iddo's decision: nothing here trusts anything until he clicks.
// Built outside renderer.js on purpose, like library.js and
// startup-overlay.js - it only reads renderer.js's globals (agents,
// activeAgentPath, selectAgent) and fails soft if they are missing.

(() => {
  "use strict";

  let list = []; // [{ agentPath, displayName, sessionCwd, since }]
  let busy = false;
  let lastMessage = null; // { kind: "error" | "info", text } shown under the banner
  let lastActive = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const currentActive = () => (typeof activeAgentPath === "undefined" ? null : activeAgentPath);
  const joinNames = (items) => items.map((a) => a.displayName).join(", ");

  // --- global banner, top of #main-panel ------------------------------------
  const banner = el("div", "hidden");
  banner.id = "untrusted-agents-banner";
  banner.setAttribute("role", "alert");
  const bannerText = el("div", "untrusted-text");
  const bannerBtn = el("button", "untrusted-trust-btn", "Trust and start them");
  bannerBtn.title =
    "Marks these agents' .claude-session folders as trusted in Claude Code (a backup of ~/.claude.json is taken first), then starts them.";
  const bannerMsg = el("div", "untrusted-msg hidden");
  const bannerRow = el("div", "untrusted-row");
  bannerRow.appendChild(bannerText);
  bannerRow.appendChild(bannerBtn);
  banner.appendChild(bannerRow);
  banner.appendChild(bannerMsg);

  // --- per-agent notice, inside #chat-view above the chat body --------------
  const pane = el("div", "hidden");
  pane.id = "untrusted-agent-pane";
  pane.setAttribute("role", "alert");
  const paneTitle = el("div", "untrusted-pane-title");
  const paneText = el(
    "div",
    "untrusted-pane-text",
    "Claude Code now asks you to confirm, once per folder, that you trust a folder before it will run an agent there. " +
      "Until then this agent cannot start, so messages to it will not be answered."
  );
  const paneBtn = el("button", "untrusted-trust-btn");
  const paneMsg = el("div", "untrusted-msg hidden");
  pane.appendChild(paneTitle);
  pane.appendChild(paneText);
  pane.appendChild(paneBtn);
  pane.appendChild(paneMsg);

  function mount() {
    const main = document.getElementById("main-panel");
    if (main && !banner.parentNode) main.insertBefore(banner, main.firstChild);
    const chatBody = document.getElementById("chat-body");
    if (chatBody && !pane.parentNode) chatBody.parentNode.insertBefore(pane, chatBody);
  }

  function showMessage(target, msg) {
    if (!msg) {
      target.classList.add("hidden");
      target.textContent = "";
      return;
    }
    target.className = "untrusted-msg " + msg.kind;
    target.textContent = msg.text;
  }

  function render() {
    mount();
    const n = list.length;
    banner.classList.toggle("hidden", n === 0 && !lastMessage);
    if (n > 0) {
      bannerText.textContent =
        `${n} agent${n === 1 ? "" : "s"} can't start until you trust ${n === 1 ? "its folder" : "their folders"} once ` +
        `(new Claude Code rule): ${joinNames(list)}`;
      bannerBtn.textContent = busy ? "Trusting and starting..." : n === 1 ? "Trust and start it" : "Trust and start them";
      bannerBtn.classList.remove("hidden");
    } else {
      bannerText.textContent = "";
      bannerBtn.classList.add("hidden");
    }
    bannerBtn.disabled = busy;
    showMessage(bannerMsg, lastMessage);

    const active = currentActive();
    const mine = active ? list.find((a) => a.agentPath === active) : null;
    pane.classList.toggle("hidden", !mine);
    if (mine) {
      paneTitle.textContent = `${mine.displayName} can't start until you trust its folder once`;
      paneBtn.textContent = busy ? "Trusting and starting..." : `Trust and start ${mine.displayName}`;
      paneBtn.disabled = busy;
      paneBtn.title = mine.sessionCwd;
      showMessage(paneMsg, lastMessage && lastMessage.kind === "error" ? lastMessage : null);
    }
    // Both elements change the chat area's height.
    if (typeof refitActiveTerminal === "function") requestAnimationFrame(refitActiveTerminal);
  }

  function update(next) {
    list = Array.isArray(next) ? next : [];
    render();
  }

  async function trust(agentPaths) {
    if (busy || !agentPaths.length) return;
    busy = true;
    lastMessage = { kind: "info", text: "Trusting and starting - this takes a few seconds per agent..." };
    render();
    const activeBefore = currentActive();
    let res;
    try {
      res = await window.api.trustAgentFolders(agentPaths);
    } catch (e) {
      res = { ok: false, error: e.message, results: [] };
    }
    busy = false;
    const results = (res && res.results) || [];
    const failed = results.filter((r) => !r.ok);
    const started = results.filter((r) => r.ok);
    if (res && res.error && !results.length) {
      lastMessage = { kind: "error", text: `Could not trust: ${res.error}` };
    } else if (failed.length) {
      lastMessage = {
        kind: "error",
        text:
          (started.length ? `Started ${joinNames(started.map((r) => ({ displayName: r.name })))}. ` : "") +
          `Still not starting: ` +
          failed.map((r) => `${r.name} (${r.error})`).join("; "),
      };
    } else {
      lastMessage = {
        kind: "success",
        text: `Trusted and started: ${joinNames(started.map((r) => ({ displayName: r.name })))}.`,
      };
    }
    // A success note clears after a few seconds; an error stays long enough to
    // read (and until the next attempt replaces it).
    const shown = lastMessage;
    setTimeout(() => {
      if (lastMessage === shown) {
        lastMessage = null;
        render();
      }
    }, shown.kind === "success" ? 8000 : 60000);
    try {
      update(await window.api.getUntrustedAgents());
    } catch (e) {
      render();
    }
    // If the agent on screen was one of them, open it again so its chat
    // attaches to the now-running process (its earlier start attempt failed).
    if (activeBefore && currentActive() === activeBefore && started.some((r) => r.agentPath === activeBefore)) {
      try {
        const agent = (typeof agents !== "undefined" ? agents : []).find((a) => a.path === activeBefore);
        if (agent && typeof selectAgent === "function") selectAgent(agent);
      } catch (e) {
        /* the user can still click the agent again */
      }
    }
  }

  bannerBtn.addEventListener("click", () => trust(list.map((a) => a.agentPath)));
  paneBtn.addEventListener("click", () => {
    const active = currentActive();
    if (active && list.some((a) => a.agentPath === active)) trust([active]);
  });

  // The pane follows whichever agent is open; renderer.js has no event for
  // that, so a cheap check of one variable is enough.
  setInterval(() => {
    const active = currentActive();
    if (active !== lastActive) {
      lastActive = active;
      render();
    }
  }, 500);

  window.api.onUntrustedAgents(update);
  window.api
    .getUntrustedAgents()
    .then(update)
    .catch(() => {
      /* no list = no banner; never block the app on this */
    });
})();

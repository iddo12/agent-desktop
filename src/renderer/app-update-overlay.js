// Update & restart (v1.58.0) - the renderer half. main.js + src/app-update.js
// decide whether a newer Agent Desktop exists and apply it; this file draws:
//
//  - a sidebar button when an update is available (same look as the Claude
//    Code update button above it), re-checked every hour, and on demand by
//    clicking the version line at the bottom of the sidebar;
//  - a full-window overlay that lists what would be interrupted and restarts
//    by itself once everything is idle. Agents are `claude --bg` processes
//    that survive the restart, so waiting is about not cutting a reply off
//    mid-stream on screen and not losing what is only held in this window:
//    queued messages (lost on restart) and the compose-box draft (saved and
//    put back after the restart by this file).
//
// Built outside renderer.js on purpose, like startup-overlay.js and
// library.js: a fault here cannot break chat. It reads renderer.js's globals
// (agents, terminals, chatInputEl) and guards.js's window.guardsBusyReason,
// all defensively.

(() => {
  "use strict";

  const CHECK_EVERY_MS = 60 * 60 * 1000;
  const FIRST_CHECK_MS = 20 * 1000; // after startup has settled
  const FOCUS_CHECK_MIN_MS = 5 * 60 * 1000;
  const POLL_MS = 3000;
  const AUTO_RESTART_SECONDS = 5;
  const DRAFT_KEY = "appUpdateSavedDraft";

  let status = null;
  let overlay = null;
  let pollTimer = null;
  let restartAt = null; // ms deadline for the automatic restart, or null
  let tickTimer = null;
  let applying = false;
  let lastError = null;
  let autoOff = false; // set after a failed apply: no automatic retry loop, only "Restart now"

  const btn = document.getElementById("app-update-btn");
  const versionEl = document.getElementById("app-version");

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // ------------------------------------------------------------ banner --

  // v1.58.2: Iddo went looking for the update at the version line and found
  // only grey text - a waiting update has to be visible right there too.
  let newLine = null;
  function renderVersionNotice() {
    if (!versionEl) return;
    if (!newLine) {
      newLine = el("div", "app-version-new hidden");
      newLine.addEventListener("click", () => btn && btn.click());
      versionEl.parentNode.insertBefore(newLine, versionEl);
    }
    const show = !!(status && status.available && status.target);
    newLine.classList.toggle("hidden", !show);
    if (show) {
      newLine.textContent = `New version v${status.target} ready - click to update`;
      newLine.title = btn ? btn.title : "";
    }
  }

  function renderButton() {
    try { renderVersionNotice(); } catch (e) { /* never block the button */ }
    if (!btn) return;
    if (!status || !status.available) {
      btn.classList.add("hidden");
      return;
    }
    if (status.mode === "release") {
      btn.textContent = `Agent Desktop v${status.target} is available - Download`;
      btn.title = "Opens the release page on GitHub.";
    } else if (status.needsPull) {
      btn.textContent = `Update Agent Desktop v${status.running} → v${status.target}` + (status.canApply ? "" : "  (needs attention)");
      btn.title = status.canApply
        ? "Pulls the new version and restarts once your agents are idle. Agents keep running through the restart."
        : status.blockers.join("\n");
    } else {
      btn.textContent = `Restart to load Agent Desktop v${status.target}`;
      btn.title = `v${status.target} is already on disk; this window is still running v${status.running}.`;
    }
    btn.classList.remove("hidden");
  }

  async function check(fetch = true) {
    try {
      status = await window.api.getAppUpdateStatus({ fetch });
    } catch (e) {
      status = null;
    }
    renderButton();
    return status;
  }

  if (btn) {
    btn.addEventListener("click", () => {
      if (!status) return;
      if (status.mode === "release") {
        if (status.url) window.api.openAppRelease(status.url);
        return;
      }
      openOverlay();
    });
  }

  // Clicking the version line checks right now and says what it found.
  if (versionEl) {
    versionEl.classList.add("app-version-clickable");
    versionEl.title = (versionEl.title ? versionEl.title + "\n" : "") + "Click to check for an Agent Desktop update";
    versionEl.addEventListener("click", async () => {
      const original = versionEl.textContent;
      versionEl.textContent = "Checking for updates…";
      const st = await check(true);
      let msg;
      if (!st) msg = "Update check failed";
      else if (st.available) msg = "Update available - see the button above";
      else if (st.error) msg = st.error;
      else if (st.mode === "none") msg = "Updates are not checked in this copy";
      else msg = "Up to date";
      versionEl.textContent = msg;
      setTimeout(() => (versionEl.textContent = original), 4000);
      if (st && st.available && st.mode !== "release") openOverlay();
    });
  }

  // ----------------------------------------------------------- overlay --

  function queuedCount() {
    let n = 0;
    try {
      for (const [, s] of terminals) n += (s && s.sendQueue && s.sendQueue.length) || 0;
    } catch (e) {}
    return n;
  }

  function draftText() {
    try {
      return (chatInputEl && chatInputEl.value) || "";
    } catch (e) {
      return "";
    }
  }

  async function busyAgents() {
    const out = [];
    let list = [];
    try {
      list = agents || [];
    } catch (e) {}
    await Promise.all(
      list.map(async (a) => {
        try {
          const act = await window.api.getSessionActivity(a.path);
          if (act && act.working) out.push(a.displayName || a.name || a.path);
        } catch (e) {}
      })
    );
    return out.sort();
  }

  function openOverlay() {
    if (overlay) return;
    overlay = el("div", "");
    overlay.id = "app-update-overlay";
    const box = el("div", "app-update-box");
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    restartAt = null;
    applying = false;
    autoOff = false;
    lastError = null;
    renderOverlay({ busy: null });
    poll();
    pollTimer = setInterval(poll, POLL_MS);
    // The countdown runs on its own 1 s clock; the agent poll is slower.
    tickTimer = setInterval(() => {
      if (!overlay || applying || restartAt == null) return;
      if (Date.now() >= restartAt) {
        restartNow();
        return;
      }
      const line = overlay.querySelector(".app-update-status");
      if (line) line.textContent = countdownText();
    }, 250);
  }

  function closeOverlay() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = tickTimer = null;
    restartAt = null;
    if (overlay) overlay.remove();
    overlay = null;
  }

  let lastBusy = null;
  async function poll() {
    if (!overlay || applying) return;
    const busy = await busyAgents();
    lastBusy = busy;
    const guard = typeof window.guardsBusyReason === "function" ? window.guardsBusyReason() : null;
    const queued = queuedCount();
    const blocked = !!(status && status.needsPull && !status.canApply);
    const clear = !autoOff && !blocked && busy.length === 0 && !guard && queued === 0;
    if (clear) {
      if (restartAt == null) restartAt = Date.now() + AUTO_RESTART_SECONDS * 1000;
    } else {
      restartAt = null;
    }
    renderOverlay({ busy, guard, queued, blocked });
  }

  const countdownText = () =>
    `Everything is idle - restarting in ${Math.max(1, Math.ceil((restartAt - Date.now()) / 1000))} s…`;

  function renderOverlay({ busy, guard, queued, blocked, error = lastError, note }) {
    if (!overlay) return;
    const box = overlay.firstChild;
    box.innerHTML = "";
    const st = status || {};
    box.appendChild(el("div", "app-update-title", "Update & restart Agent Desktop"));
    box.appendChild(
      el("div", "app-update-sub", `v${st.running || "?"}  →  v${st.target || "?"}` + (st.fake ? "   (test mode - nothing is pulled or restarted)" : ""))
    );

    if (st.needsPull && st.commits && st.commits.length) {
      box.appendChild(el("div", "app-update-h", `What's new (${st.behind} change${st.behind === 1 ? "" : "s"})`));
      const ul = el("ul", "app-update-commits");
      for (const c of st.commits) ul.appendChild(el("li", "", c));
      if (st.behind > st.commits.length) ul.appendChild(el("li", "app-update-muted", `…and ${st.behind - st.commits.length} more`));
      box.appendChild(ul);
    } else if (!st.needsPull) {
      box.appendChild(el("div", "app-update-p", "The new version is already on disk. Only a restart is needed."));
    }

    if (blocked) {
      box.appendChild(el("div", "app-update-h app-update-bad", "Can't update yet"));
      const ul = el("ul", "app-update-list");
      for (const b of st.blockers || []) ul.appendChild(el("li", "", b));
      box.appendChild(ul);
    } else {
      box.appendChild(el("div", "app-update-h", "Before restarting"));
      const ul = el("ul", "app-update-list");
      if (busy == null) ul.appendChild(el("li", "app-update-muted", "Checking which agents are working…"));
      else if (busy.length) ul.appendChild(el("li", "", `Waiting for ${busy.length} agent${busy.length === 1 ? "" : "s"} to finish: ${busy.join(", ")}`));
      else ul.appendChild(el("li", "app-update-ok", "No agent is working."));
      if (guard) ul.appendChild(el("li", "", `Waiting: ${guard}.`));
      if (queued) ul.appendChild(el("li", "", `${queued} queued message${queued === 1 ? "" : "s"} still to send (they would be lost).`));
      if (draftText().trim()) ul.appendChild(el("li", "app-update-muted", "Your unsent text in the message box is saved and put back after the restart."));
      ul.appendChild(el("li", "app-update-muted", "Agents keep running through the restart; nothing they are doing is lost."));
      box.appendChild(ul);
    }

    const statusLine = el("div", "app-update-status");
    if (error) {
      statusLine.textContent = error;
      statusLine.classList.add("app-update-bad");
    } else if (note) {
      statusLine.textContent = note;
    } else if (!blocked && restartAt != null) {
      statusLine.textContent = countdownText();
    } else if (!blocked && autoOff) {
      statusLine.textContent = "Automatic restart is off after that error - use Restart now to try again.";
    } else if (!blocked && busy != null) {
      statusLine.textContent = "Will restart by itself as soon as everything is idle.";
    }
    box.appendChild(statusLine);

    const actions = el("div", "app-update-actions");
    if (!blocked) {
      const now = el("button", "primary", applying ? "Restarting…" : "Restart now");
      now.disabled = applying;
      now.addEventListener("click", () => restartNow(true));
      actions.appendChild(now);
    } else {
      const again = el("button", "", "Check again");
      again.addEventListener("click", async () => {
        await check(true);
        if (!status || !status.available) closeOverlay();
        else poll();
      });
      actions.appendChild(again);
    }
    const cancel = el("button", "", blocked ? "Close" : "Cancel");
    cancel.disabled = applying;
    cancel.addEventListener("click", closeOverlay);
    actions.appendChild(cancel);
    box.appendChild(actions);
  }

  async function restartNow(manual) {
    if (applying) return;
    const queued = queuedCount();
    if (manual && queued && !confirm(`${queued} queued message(s) have not been sent yet and will be lost. Restart anyway?`)) return;
    applying = true;
    restartAt = null;
    renderOverlay({ busy: lastBusy, note: status && status.needsPull ? "Pulling the new version…" : "Restarting…" });
    const draft = draftText();
    try {
      if (draft.trim()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: draft, at: Date.now() }));
    } catch (e) {}
    let r;
    try {
      r = await window.api.applyAppUpdate();
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!r || !r.ok) {
      applying = false;
      autoOff = true;
      lastError = (r && r.error) || "The update failed.";
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch (e) {}
      await check(false);
      renderOverlay({ busy: lastBusy });
      return;
    }
    if (r.restarting) {
      applying = true; // the window is about to go; keep the buttons dead
      renderOverlay({ busy: lastBusy, note: `Restarting onto v${r.version || status.target}…` });
      return;
    }
    // Test mode: applied without a restart. `applying` stays true so the poll
    // does not arm another countdown before the overlay closes.
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
    renderOverlay({ busy: lastBusy, note: `Test mode: the update step ran (v${r.version}); a real install would restart now.` });
    setTimeout(closeOverlay, 4000);
  }

  // Put back a draft saved by a restart (only into an empty box, only if recent).
  function restoreDraft() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
    if (!saved || !saved.text || Date.now() - (saved.at || 0) > 15 * 60 * 1000) return;
    try {
      if (chatInputEl && !chatInputEl.value) {
        chatInputEl.value = saved.text;
        chatInputEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (e) {}
  }

  // Exposed for the sandbox driver and for debugging from the console.
  window.appUpdate = { check, openOverlay, closeOverlay, getStatus: () => status };

  setTimeout(restoreDraft, 3000);
  setTimeout(() => check(true), FIRST_CHECK_MS);
  setInterval(() => check(true), CHECK_EVERY_MS);
  // v1.58.2: an hourly-only check left the button hidden for up to an hour
  // after a push. Also check when the window regains focus, at most every
  // FOCUS_CHECK_MIN_MS so switching windows doesn't hammer git/GitHub.
  let lastFocusCheck = Date.now();
  window.addEventListener("focus", () => {
    if (Date.now() - lastFocusCheck < FOCUS_CHECK_MIN_MS) return;
    lastFocusCheck = Date.now();
    check(true);
  });
})();

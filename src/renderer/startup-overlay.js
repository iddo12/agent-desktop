// Startup countdown overlay (v1.53.0). Iddo: "Can you put some big numbers on
// the screen (counting down) until agent desktop fully loads so I will know not
// to interact with it until it's ready?"
//
// What "ready" means, and where the estimate comes from, is decided in main.js
// (startupState / startupProgress, next to createWindow). This file only draws:
// a full-window layer that swallows clicks and keys, a very large seconds-left
// number, and "Agents ready: N of M (name)" as each agent is processed.
//
// Built outside renderer.js on purpose, the same way library.js is: it touches
// nothing existing, so a fault here cannot break chat, and removing it is one
// <script> and one <link>.
//
// It can never trap him: a "Use it anyway" link dismisses it, and it removes
// itself after STARTUP_OVERLAY_MAX_MS whatever main says.
//
// Known, inherent: while the main process is blocked (a synchronous spawn, a
// busy-wait retry), IPC and sometimes the window's own repaint stall with it,
// so the number can pause and then jump several seconds at once. The countdown
// is computed from the clock, not decremented per tick, so it is always right
// once the window paints again - it just cannot paint while main is stuck.

(() => {
  "use strict";

  const STARTUP_OVERLAY_MAX_MS = 5 * 60 * 1000; // hard safety cap, measured from app start
  const READY_HOLD_MS = 1000; // how long "Ready" stays up before fading
  const FADE_MS = 400; // keep in step with the transition in styles-startup.css
  const TICK_MS = 250;

  let state = null; // last snapshot from main
  let clockOffset = 0; // main's clock minus ours (same machine, so ~0 - but free to be exact)
  let overlay = null;
  let numberEl = null;
  let progressEl = null;
  let tickTimer = null;
  let closing = false;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const nowMain = () => Date.now() + clockOffset;

  function adopt(snapshot) {
    if (!snapshot) return;
    state = snapshot;
    if (Number.isFinite(snapshot.now)) clockOffset = snapshot.now - Date.now();
  }

  // Keys typed while the overlay is up would land in whatever had focus (the
  // compose box, usually) - blocked in the capture phase, except on the
  // overlay's own link so it stays keyboard-reachable.
  function swallowKeys(e) {
    if (!overlay || (overlay.contains(e.target) && e.target.classList.contains("startup-overlay-skip"))) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function build() {
    overlay = el("div");
    overlay.id = "startup-overlay";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-live", "polite");
    const box = el("div", "startup-overlay-box");
    box.appendChild(el("div", "startup-overlay-title", "Agent Desktop is starting - please wait"));
    numberEl = el("div", "startup-overlay-number");
    box.appendChild(numberEl);
    progressEl = el("div", "startup-overlay-progress");
    box.appendChild(progressEl);
    const skip = el("a", "startup-overlay-skip", "Use it anyway");
    skip.href = "#";
    skip.title = "Close this screen now. Agents that are still starting may not respond yet.";
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        window.api.dismissStartup();
      } catch (err) {}
      close(false);
    });
    box.appendChild(skip);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    window.addEventListener("keydown", swallowKeys, true);
    window.addEventListener("keypress", swallowKeys, true);
    try {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    } catch (err) {}
    skip.focus();
  }

  function render() {
    if (!overlay || closing || !state) return;
    const elapsed = nowMain() - state.startedAt;
    if (elapsed >= STARTUP_OVERLAY_MAX_MS) {
      close(false);
      return;
    }
    const secondsLeft = Math.max(0, Math.ceil((state.estimateMs - elapsed) / 1000));
    if (secondsLeft > 0) {
      numberEl.textContent = String(secondsLeft);
      numberEl.classList.remove("startup-overlay-almost");
    } else {
      // Past the estimate but not ready yet: never count negative.
      numberEl.textContent = "Almost ready...";
      numberEl.classList.add("startup-overlay-almost");
    }
    if (state.total > 0) {
      const name = state.agentName ? ` (${state.agentName})` : "";
      progressEl.textContent = `Agents ready: ${state.done} of ${state.total}${name}`;
    } else {
      // The first sweep waits ~10 s after launch before it lists the agents.
      progressEl.textContent = "Getting ready to check the agents...";
    }
  }

  function close(showReady) {
    if (!overlay || closing) return;
    closing = true;
    clearInterval(tickTimer);
    const finish = () => {
      overlay.classList.add("startup-overlay-fading");
      setTimeout(() => {
        window.removeEventListener("keydown", swallowKeys, true);
        window.removeEventListener("keypress", swallowKeys, true);
        if (overlay) overlay.remove();
        overlay = null;
      }, FADE_MS);
    };
    if (showReady) {
      numberEl.textContent = "Ready";
      numberEl.classList.remove("startup-overlay-almost");
      numberEl.classList.add("startup-overlay-ready");
      if (state && state.total > 0) progressEl.textContent = `Agents ready: ${state.done} of ${state.total}`;
      setTimeout(finish, READY_HOLD_MS);
    } else {
      finish();
    }
  }

  function start(snapshot) {
    adopt(snapshot);
    // Already ready (a reload after startup), dismissed earlier, or past the
    // cap: draw nothing at all.
    if (!state || state.ready || state.dismissed || nowMain() - state.startedAt >= STARTUP_OVERLAY_MAX_MS) return;
    build();
    render();
    tickTimer = setInterval(render, TICK_MS);
  }

  // Subscribed before the query so an event that lands while it is in flight
  // is not lost; until `state` exists these only record the snapshot.
  window.api.onStartupProgress((snapshot) => {
    adopt(snapshot);
    render();
  });
  window.api.onStartupReady((snapshot) => {
    adopt(snapshot);
    close(true);
  });

  window.api
    .getStartupState()
    .then((snapshot) => {
      // A progress/ready event may have arrived first and be newer.
      if (state && (state.ready || state.done > (snapshot && snapshot.done))) snapshot = state;
      start(snapshot);
    })
    .catch(() => {
      /* no state = no overlay; never block the app on this */
    });
})();

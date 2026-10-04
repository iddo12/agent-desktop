// v1.69.17: a visible banner when the open agent is blocked on a permission prompt ("approve Bash: ...").
// Before this the app only said "Working..." while the agent sat for hours waiting for a click nobody could see.
// The buttons are Iddo's click only: Approve presses Enter on the prompt's default Yes, Deny presses Escape.
// Nothing is ever approved automatically. The data comes from main.js (approvalPending, read from the daemon job file).
(function () {
  if (!window.api || !window.api.approvalPending) return;
  let box = null, lastKey = "";
  function ensureBox() {
    if (box) return box;
    box = document.createElement("div");
    box.id = "approval-banner";
    box.className = "approval-banner hidden";
    const q = document.getElementById("chat-queue");
    if (q && q.parentNode) q.parentNode.insertBefore(box, q);
    else return null;
    return box;
  }
  function fmt(ms) { const m = Math.round(ms / 60000); return m < 1 ? "under a minute" : m < 90 ? m + " min" : (m / 60).toFixed(1) + " h"; }
  async function poll() {
    try {
      const ap = typeof activeAgentPath !== "undefined" ? activeAgentPath : null;
      const el = ensureBox();
      if (!el) return;
      const p = ap ? await window.api.approvalPending(ap) : null;
      if (!p) { if (!el.classList.contains("hidden")) { el.classList.add("hidden"); el.textContent = ""; lastKey = ""; } return; }
      const key = ap + "|" + p.needs + "|" + p.promptOnScreen;
      const head = "Waiting for your approval for " + fmt(Date.now() - p.since);
      if (key === lastKey) { const h = el.querySelector(".approval-head"); if (h) h.textContent = head; return; }
      lastKey = key;
      el.textContent = "";
      const h = document.createElement("div"); h.className = "approval-head"; h.textContent = head;
      const c = document.createElement("div"); c.className = "approval-cmd"; c.textContent = p.needs.replace(/^approve\s*/i, "");
      const msg = document.createElement("div"); msg.className = "approval-msg";
      const row = document.createElement("div"); row.className = "approval-row";
      const mk = (label, answer, cls) => {
        const b = document.createElement("button"); b.textContent = label; b.className = cls;
        b.addEventListener("click", async (ev) => {
          if (!ev.isTrusted) return;   // a real click only, never a script
          b.disabled = true;
          const r = await window.api.approvalAnswer(ap, answer, p.since).catch((e) => ({ ok: false, reason: e.message }));
          msg.textContent = r && r.ok ? (answer === "approve" ? "Approved - the agent continues." : "Denied.") : "Could not answer: " + ((r && r.reason) || "unknown") + ".";
          setTimeout(() => { lastKey = ""; poll(); }, 2500);
        });
        return b;
      };
      row.append(mk("Approve", "approve", "approval-yes"), mk("Deny", "deny", "approval-no"));
      el.append(h, c, row, msg);
      if (!p.promptOnScreen) msg.textContent = "The prompt is not on this screen yet. If Approve does nothing, use Session > Restart session.";
      el.classList.remove("hidden");
    } catch (e) { /* never break the chat */ }
  }
  setInterval(poll, 5000);
})();

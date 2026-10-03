// CPU guard / start limiter banner (v1.66.0). The main process (src/cpuGuardGlue.js) sends the state; this
// file only draws a thin strip at the top of #main-panel. Hidden when there is nothing to say. No timers.

(() => {
  "use strict";
  const api = window.api;
  if (!api || !api.onCpuGuardState) return;

  const banner = document.createElement("div");
  banner.id = "cpuguard-banner";
  banner.className = "hidden";
  banner.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "cpuguard-text";
  banner.appendChild(text);

  function mount() {
    const main = document.getElementById("main-panel");
    if (main && !banner.parentNode) main.insertBefore(banner, main.firstChild);
  }

  function render(st) {
    mount();
    if (!st || !st.show) {
      banner.className = "hidden";
      return;
    }
    banner.className = "cpuguard-" + st.kind;
    text.textContent = st.text;
  }

  api.onCpuGuardState(render);
  if (api.getCpuGuardState) api.getCpuGuardState().then((r) => render(r && r.banner)).catch(() => {});
})();

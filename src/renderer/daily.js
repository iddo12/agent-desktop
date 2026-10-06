// My Daily (v1.72.0) - one place for tasks, schedule, shopping lists, emails and dates. Loaded after argus.js
// (so the sidebar order is ARGUS, My Daily, IRIS). Self-contained and wrapped so a fault here can only break
// this view. LIGHT: no timers and no polling - data is loaded when the view opens or the sidebar entry is
// hovered (cached 60 s in the main process), plus ONE read shortly after start to draw the badge.
// textContent only: titles and names come from files, mail and the web and are never parsed as HTML.
(function () {
  "use strict";
  if (!window.api || !window.api.daily || !window.dailySchedule) return;
  const api = window.api.daily;

  const TABS = [
    ["today", "Today"], ["emails", "Emails"], ["schedule", "Schedule"], ["tasks", "Tasks"],
    ["shopping", "Shopping lists"], ["dates", "Birthdays & dates"],
  ];
  const PRI_COLORS = ["#f3f0e8", "#f0e6c0", "#ecdc9f", "#e8d085", "#e6bf6b", "#e5a95a", "#e48d4c", "#e2703f", "#dc4f35", "#c93a2a"];
  const STATUS_LABEL = { needs: "▲ Needs you", working: "▶ Working", waiting: "◐ Waiting", queued: "○ Queued" };
  const STATUS_CLASS = { needs: "you", working: "w", waiting: "wait", queued: "q" };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(label, cls, onClick) {
    const b = el("button", cls || "", label);
    b.type = "button";
    b.addEventListener("click", (ev) => { ev.preventDefault(); onClick(ev); });
    return b;
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const clock = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
  const sub = (o) => (o ? `oldest ${o.days}d${o.owner ? " · " + o.owner : ""}` : "");
  function agoText(ms, now) {
    const m = Math.round(((now || Date.now()) - ms) / 60000);
    return m < 1 ? "just now" : m === 1 ? "1 min ago" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  }

  // ---------------------------------------------------------------- state
  let payload = null;       // last daily-load result
  let tab = "today";
  let showSettings = false;
  let loading = null;       // in-flight load promise
  let newListOpen = false;

  function load(force) {
    if (loading) return loading;
    loading = api.load(force).then((p) => { if (p && !p.error) payload = p; return p; })
      .catch((e) => { console.error("daily load", e); return null; })
      .finally(() => { loading = null; });
    return loading;
  }

  // ---------------------------------------------------------------- sidebar entry
  const nav = el("button", "daily-nav");
  nav.title = "My Daily - tasks, schedule, shopping lists, emails and dates";
  const navDot = el("span", "daily-nav-dot");
  const navName = el("span", "daily-nav-name", "My Daily");
  const navBadge = el("span", "daily-nav-badge hidden");
  nav.append(navDot, navName, navBadge);
  const agentList = document.getElementById("agent-list");
  const libNav = document.getElementById("library-nav");
  agentList.parentNode.insertBefore(nav, libNav || agentList);
  nav.addEventListener("click", () => { hideDigest(true); isOpen() ? closeView() : openView(); });

  function paintBadge() {
    if (!payload) return;
    const b = payload.badge || { count: 0, blue: false };
    navBadge.textContent = b.count ? String(b.count) : "";
    navBadge.classList.toggle("hidden", !b.count);
    navBadge.classList.toggle("blue", !!b.blue);
    navDot.classList.toggle("blue", !!b.blue);
    navBadge.title = `${b.count} open task${b.count === 1 ? "" : "s"}${b.blue ? " - something needs you" : ""}`;
  }

  // ---------------------------------------------------------------- view shell
  const view = el("div");
  view.id = "daily-view";
  view.className = "hidden";
  document.getElementById("main-panel").appendChild(view);
  const head = el("div", "daily-head");
  const titleEl = el("b", "daily-title", "My Daily");
  const dateEl = el("span", "daily-date");
  const headSp = el("span", "daily-sp");
  const refreshBtn = btn("↻", "daily-btn daily-refresh", () => { load(true).then(render); });
  refreshBtn.title = "Reload tasks, mail and calendar now";
  const settingsBtn = btn("Settings", "daily-btn", () => { showSettings = !showSettings; render(); });
  const askBtn = btn("Ask assistant", "daily-btn pri", () => askAssistant());
  head.append(titleEl, dateEl, headSp, refreshBtn, settingsBtn, askBtn);
  const tabsEl = el("div", "daily-tabs");
  const body = el("div", "daily-body");
  const toast = el("div", "daily-toast hidden");
  view.append(head, tabsEl, body, toast);

  const isOpen = () => document.body.classList.contains("daily-open");
  function openView(wantTab) {
    if (wantTab) { tab = wantTab; showSettings = false; }
    document.body.classList.add("daily-open");
    listenDocument(true);
    view.classList.remove("hidden");
    nav.classList.add("active");
    if (document.body.classList.contains("argus-open")) document.querySelector("#argus-view .argus-close")?.click();
    if (document.body.classList.contains("iris-open")) document.querySelector("#iris-view .iris-close")?.click();
    if (document.body.classList.contains("memory-open")) { document.body.classList.remove("memory-open"); document.getElementById("memory-view")?.classList.add("hidden"); document.querySelector(".memory-nav")?.classList.remove("active"); }
    const lib = document.getElementById("library-view");
    if (lib && !lib.classList.contains("hidden")) document.querySelector("#library-view .library-close")?.click();
    render();
    if (!ro && typeof ResizeObserver === "function") { ro = new ResizeObserver(() => { if (isOpen() && computeLayout() !== layout) render(); }); ro.observe(view); }
    load(false).then(render);
  }
  // Width watcher: event-driven (no timer) and only attached while My Daily is open.
  let ro = null;
  function closeView() {
    cancelVoice();
    closePop();
    if (ro) { ro.disconnect(); ro = null; }
    listenDocument(false);
    clearTimeout(say.t);
    showAllTasks = false; showAllItems = false;
    document.body.classList.remove("daily-open");
    view.classList.add("hidden");
    nav.classList.remove("active");
  }
  // Document-level listeners exist only while My Daily is open (added in openView, removed in closeView).
  // Any other sidebar destination closes this view first (capture, so it runs before their handlers).
  const onDocClick = (e) => { if (e.target.closest(".argus-nav, .iris-nav, .memory-nav, #library-nav, #agent-list .agent-item")) closeView(); };
  const onDocKey = (e) => { if (e.key === "Escape" && !e.target.closest("#daily-view input, #daily-view textarea")) closeView(); };
  const onDocPop = (e) => { if (pop && !e.target.closest(".daily-pop, .daily-popper")) closePop(); };
  let docListening = false;
  function listenDocument(on) {
    if (on === docListening) return;
    docListening = on;
    const f = on ? "addEventListener" : "removeEventListener";
    document[f]("click", onDocClick, true);
    document[f]("keydown", onDocKey);
    document[f]("click", onDocPop, true);
  }

  function say(msg) {
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(say.t);
    say.t = setTimeout(() => toast.classList.add("hidden"), 4000);
  }

  function findAgent(name) {
    try {
      const list = typeof agents !== "undefined" ? agents : [];
      const n = String(name || "").toLowerCase();
      return list.find((a) => String(a.folderName || "").toLowerCase() === n || String(a.displayName || "").toLowerCase() === n) || null;
    } catch (e) { return null; }
  }
  function jumpToAgent(name) {
    const a = findAgent(name);
    if (!a || typeof selectAgent !== "function") { say(`No agent called "${name}" was found in this Agent Desktop.`); return; }
    closeView();
    selectAgent(a);
  }
  function askAssistant() {
    const a = (typeof agents !== "undefined" ? agents : []).find((x) => /personal assistant/i.test((x.displayName || "") + " " + (x.folderName || "")));
    if (!a) { say("No Personal Assistant agent was found. Ask any agent from its own chat."); return; }
    closeView();
    selectAgent(a);
  }

  // ---------------------------------------------------------------- pieces
  function num(n, cls, title, onClick) {
    const s = el("span", `daily-n ${cls || ""}`.trim(), String(n));
    s.setAttribute("role", "button");
    s.tabIndex = 0;
    if (title) s.title = title;
    if (onClick) s.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
    return s;
  }
  function priBar(p) {
    const wrap = el("span", "daily-pri");
    wrap.title = `Priority ${p} of 10`;
    const tr = el("span", "daily-pri-tr");
    const fl = el("span", "daily-pri-fl");
    fl.style.width = p * 10 + "%";
    fl.style.background = PRI_COLORS[p - 1];
    tr.append(fl);
    wrap.append(tr, el("b", null, String(p)));
    return wrap;
  }
  function card(titleText, extra) {
    const c = el("section", "daily-card");
    const h = el("h3", "daily-card-h");
    h.append(el("span", null, titleText));
    if (extra) for (const x of extra) h.append(x);
    c.append(h);
    return c;
  }
  function emptyState(title, text, btnLabel, onClick) {
    const w = el("div", "daily-empty");
    w.append(el("div", "daily-empty-ico", "+"), el("b", null, title), el("span", "daily-muted", text));
    if (btnLabel) w.append(btn(btnLabel, "daily-btn pri", onClick));
    return w;
  }
  function legendPriority() {
    const l = el("div", "daily-legend");
    l.append(el("span", "daily-muted", "Priority"), el("span", "daily-muted", "1 low"));
    for (let i = 1; i <= 10; i++) { const sw = el("span", "daily-sw", String(i)); sw.style.background = PRI_COLORS[i - 1]; l.append(sw); }
    l.append(el("span", "daily-muted", "10 highest"));
    return l;
  }
  // Damaged-file notices from the main process (a store was restored from its backup or started empty).
  function noticeBanner(list) {
    const b = el("div", "daily-banner daily-notice");
    b.setAttribute("role", "alert");
    b.append(el("b", null, "● Heads up: "), document.createTextNode(list.join(" ")), document.createTextNode(" "));
    b.append(btn("Dismiss", "daily-btn sm", async () => { if (api.clearNotices) await api.clearNotices(); await load(true); render(); }));
    return b;
  }
  function demoBanner(kind) {
    const pv = payload.provider;
    if (pv.emailsConnected) {
      const at = pv.emailsUpdatedAt ? new Date(pv.emailsUpdatedAt) : null;
      const when = at ? ` Updated ${at.getDate()} ${MONTHS[at.getMonth()]} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}.` : "";
      if (kind === "emails") return el("div", "daily-banner info", `${pv.emailsLabel}.${when} Google Mail is not connected yet.`);
      return el("div", "daily-banner", `${pv.emailsLabel}. The calendar is not connected yet, so events are examples.`);
    }
    return el("div", "daily-banner", `${pv.label}. Email and calendar are not connected yet, so these are examples.`);
  }

  // ---------------------------------------------------------------- tabs
  function tabCounts() {
    const s = payload && payload.summary;
    if (!s) return {};
    return {
      emails: [s.emailsAttention, "blue", `${s.emailsAttention} need attention${s.sentOldest || s.emailsNeedOldest ? " - " + sub(s.emailsNeedOldest) : ""}`],
      tasks: [s.tasksOpen, "", `${s.tasksOpen} open - ${sub(s.tasksOldest)}`],
      shopping: [s.shopLists, "", `${s.shopLists} list${s.shopLists === 1 ? "" : "s"}${s.shopOldest ? " - oldest item " + s.shopOldest.days + "d" : ""}`],
      dates: [s.datesCount, "", s.datesNext ? `next in ${s.datesNext.inDays}d` : ""],
    };
  }
  // Layout follows the width of the My Daily view itself (not the window): full tab bar, "More" menu, or sideways-scrolling tabs.
  let layout = "full";
  function computeLayout() { const w = view.clientWidth || 1000; return w >= 770 ? "full" : w >= 540 ? "more" : "narrow"; }
  function renderTabs() {
    tabsEl.replaceChildren();
    const counts = tabCounts();
    const hidden = layout === "more" ? ["dates"] : [];
    for (const [id, label] of TABS) {
      if (hidden.includes(id)) continue;
      const b = el("button", "daily-tab" + (!showSettings && tab === id ? " on" : ""));
      b.type = "button";
      b.append(el("span", null, label));
      const c = counts[id];
      if (c && c[0]) b.append(num(c[0], c[1], c[2]));
      b.addEventListener("click", () => { tab = id; showSettings = false; render(); });
      tabsEl.append(b);
    }
    if (hidden.length) {
      const on = !showSettings && hidden.includes(tab);
      const mb = el("button", "daily-tab daily-popper" + (on ? " on" : ""));
      mb.type = "button";
      mb.append(el("span", null, "More ▾"));
      const total = hidden.reduce((a, id) => a + ((counts[id] && counts[id][0]) || 0), 0);
      if (total) mb.append(num(total, "", "Items in the tabs under More"));
      mb.addEventListener("click", () => openPop(mb, (p) => {
        for (const id of hidden) {
          const lab = TABS.find((x) => x[0] === id)[1];
          const c = counts[id];
          const it = btn("", "daily-pop-item daily-more-item" + (tab === id && !showSettings ? " on" : ""), () => { closePop(); tab = id; showSettings = false; render(); });
          it.append(el("span", null, lab));
          if (c && c[0]) it.append(el("span", "daily-n", String(c[0])));
          if (c && c[2]) it.append(el("small", "daily-muted", c[2]));
          p.append(it);
        }
        const st = btn("", "daily-pop-item daily-more-item" + (showSettings ? " on" : ""), () => { closePop(); showSettings = true; render(); });
        st.append(el("span", null, "Settings: calendar sharing & sync"), el("small", "daily-muted", "gear"));
        p.append(st);
      }));
      tabsEl.append(mb);
    }
  }

  // ---------------------------------------------------------------- Today
  function renderToday() {
    const s = payload.summary, d = payload.data, now = payload.now;
    const wrap = el("div", "daily-today");
    if (!payload.provider.connected) wrap.append(demoBanner());

    const chip = (big, color, label, subText, onClick) => {
      const c = el("button", "daily-chip");
      c.type = "button";
      const n = el("span", "daily-chip-big", String(big));
      n.style.color = color;
      c.append(n, el("span", null, label), el("small", null, subText));
      c.addEventListener("click", onClick);
      return c;
    };
    const strip = el("div", "daily-strip");
    strip.append(
      chip(s.emailsNeedAnswer, "var(--health-critical)", "Emails need an answer", sub(s.emailsNeedOldest), () => { tab = "emails"; render(); }),
      chip(s.tasksNeed, "var(--daily-blue)", "Tasks need you", sub(s.tasksNeedOldest), () => { tab = "tasks"; render(); }),
      chip(s.tasksOpen, "var(--text)", "Open tasks", sub(s.tasksOldest), () => { tab = "tasks"; render(); }),
      chip(s.sentNoReply, "var(--health-warning)", "Sent, no reply 3+ d", sub(s.sentOldest), () => { tab = "emails"; render(); }),
    );
    wrap.append(strip);

    const two = el("div", "daily-two");
    // Today's schedule
    const sched = card("Today", [el("span", "daily-sp"), btn("Schedule", "daily-btn sm", () => { tab = "schedule"; render(); })]);
    sched.classList.add("grow");
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = dayStart.getTime() + 86400000;
    const todays = (d.events || []).filter((e) => e.start >= dayStart.getTime() && e.start < dayEnd);
    const nextIdx = todays.findIndex((e) => (e.end || e.start) > now);
    if (!todays.length) sched.append(el("div", "daily-muted daily-pad", "Nothing scheduled today."));
    todays.forEach((e, i) => {
      const row = el("div", "daily-ev" + (i === nextIdx ? " now" : ""));
      row.append(el("span", "daily-tm", e.end && e.end - e.start >= 3600000 ? `${clock(e.start)}–${clock(e.end)}` : clock(e.start)));
      const t = el("span");
      t.append(i === nextIdx ? el("b", null, e.title) : document.createTextNode(e.title));
      if ((e.end || e.start) <= now) t.append(el("small", "daily-muted", " · done"));
      else if (e.leaveBy) t.append(el("small", "daily-muted", " · leave by " + e.leaveBy));
      row.append(t);
      sched.append(row);
    });
    // Top emails
    const mails = card("Top emails today", [num(s.emailsAttention, "blue", "Open Emails", () => { tab = "emails"; render(); }), el("span", "daily-sp"), btn("Emails", "daily-btn sm", () => { tab = "emails"; render(); })]);
    mails.classList.add("grow");
    for (const m of d.emails.top.slice(0, 3)) {
      const row = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      const meta = el("small", "daily-muted");
      meta.append(document.createTextNode(clock(m.at) + " · "), el("span", "daily-acct", m.account));
      ti.append(el("div", null, m.subject), meta);
      const imp = el("span", "daily-imp", "●".repeat(m.importance) + "○".repeat(3 - m.importance));
      imp.title = `Importance ${m.importance} of 3`;
      row.append(ti, imp);
      mails.append(row);
    }
    mails.append(el("div", "daily-leg", "●●● very important · ●●○ important · ●○○ routine"));
    two.append(sched, mails);
    wrap.append(two);

    // Top tasks by priority
    const tasks = card("Top tasks by priority");
    const top = (d.tasks || []).slice(0, 2);
    if (!top.length) tasks.append(el("div", "daily-muted daily-pad", "No open tasks."));
    for (const t of top) {
      const row = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      const meta = el("small", "daily-muted");
      meta.append(document.createTextNode(`${t.ageDays}d · ${t.agent} · `), el("span", "daily-scope " + (t.area === "Personal" ? "per" : "biz"), t.area));
      if (t.list) meta.append(document.createTextNode(" · "), el("span", "daily-cat", t.list));
      ti.append(el("div", null, t.title), meta);
      const st = el("span", "daily-st " + STATUS_CLASS[t.status], STATUS_LABEL[t.status]);
      row.append(ti, priBar(t.priority), st, btn("Open", "daily-btn sm", () => jumpToAgent(t.agent)));
      tasks.append(row);
    }
    tasks.append(legendPriority());
    wrap.append(tasks);
    return wrap;
  }

  // ---------------------------------------------------------------- small floating menu (status / priority / lists)
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function openPop(anchor, build) {
    closePop();
    pop = el("div", "daily-pop");
    build(pop);
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - w - 8)) + "px";
    pop.style.top = Math.round(r.bottom + 4) + "px";
  }

  async function after(r, okMsg) {
    if (r && r.ok) { await load(true); render(); if (okMsg) say(okMsg); return true; }
    say((r && r.reason) || "That did not work.");
    return false;
  }

  // ---------------------------------------------------------------- Voice record (phase 4)
  // One recording at a time. voice = {kind: "tasks"|"shopping"|"schedule", phase: starting|recording|transcribing|error|review, handle, text, msg, review}.
  // The microphone exists only while phase is "recording"; leaving the tab, closing My Daily or Cancel releases it.
  let voice = null;
  const VP = () => window.dailyVoiceParse;
  function cancelVoice() {
    if (voice && voice.handle) { try { voice.handle.cancel(); } catch (e) { /* already released */ } }
    voice = null;
  }
  async function startVoice(kind) {
    if (voice && voice.kind === kind && voice.phase === "recording") { stopVoice(); return; }
    if (voice && (voice.phase === "starting" || voice.phase === "transcribing")) return;
    cancelVoice();
    if (!window.dailyVoice) { say("Voice recording is not available in this build."); return; }
    const mine = (voice = { kind, phase: "starting" });
    render();
    let r;
    try { r = await window.dailyVoice.begin(() => { if (voice === mine) stopVoice(); }); } catch (e) { r = { ok: false, error: "Could not start recording." }; }
    if (voice !== mine) { if (r && r.ok) r.cancel(); return; }    // cancelled while the mic was starting
    if (!r.ok) { mine.phase = "error"; mine.msg = r.error; render(); return; }
    mine.handle = r; mine.phase = "recording"; render();
  }
  async function stopVoice() {
    const mine = voice;
    if (!mine || mine.phase !== "recording") return;
    mine.phase = "transcribing"; render();
    let res;
    try { res = await mine.handle.stop(); } catch (e) { res = { ok: false, error: "Transcription failed." }; }
    if (voice !== mine) return;                                   // cancelled meanwhile
    mine.handle = null;
    if (!res.ok) { mine.phase = "error"; mine.msg = res.error; render(); return; }
    mine.text = res.text;
    try {
      if (mine.kind === "shopping") {
        const items = VP().splitItems(res.text);
        if (!items.length) { mine.phase = "error"; mine.msg = "I could not find any items in what was said."; render(); return; }
        mine.review = { items };
      } else if (mine.kind === "tasks") {
        const title = VP().taskTitle(res.text);
        if (!title) { mine.phase = "error"; mine.msg = "I could not find a task in what was said."; render(); return; }
        const agents = Array.from(new Set((payload.data.tasks || []).map((t) => t.agent).concat(["Personal Assistant"])));
        mine.review = { title, agent: "Personal Assistant", agents, area: tf.area === "Business" ? "Business" : "Personal", priority: 5, list: tf.list === "(no list)" ? "" : tf.list };
      } else {
        const p = VP().parseAppointment(res.text, payload.now);
        const keep = apptForm && apptForm.id ? { id: apptForm.id } : {};
        apptForm = Object.assign(keep, { who: p.who, voiceText: res.text, voiceMissing: [p.hasDate ? "" : "date", p.hasTime ? "" : "time"].filter(Boolean) });
        if (p.start) { apptForm.start = p.start; apptForm.end = p.end; } else apptForm.start = apptForm.start || cursor || payload.now;
        voice = null; tab = "schedule"; render(); return;
      }
      mine.phase = "review";
    } catch (e) {
      console.error("daily voice parse", e);
      mine.phase = "error"; mine.msg = "I could not make sense of that recording.";
    }
    render();
  }
  function recBtn(kind, cls, label) {
    const on = voice && voice.kind === kind && voice.phase === "recording";
    const b = btn(on ? "■ Stop" : label || "Record ●", (cls || "daily-btn") + (on ? " recording" : ""), () => startVoice(kind));
    b.title = on ? "Stop recording" : "Record by voice";
    if (!on && /●$/.test(b.textContent)) { b.textContent = b.textContent.replace(/\s*●$/, "") + " "; b.append(el("span", "daily-recdot", "●")); }   // the dot is red like the mockups
    return b;
  }
  // The strip under the toolbar: progress, errors and the check-before-saving step.
  function voicePanel(kind, ctx) {
    if (!voice || voice.kind !== kind) return null;
    const box = el("section", "daily-card daily-voice " + voice.phase);
    const row = el("div", "daily-voice-row");
    if (voice.phase === "starting") { row.append(el("span", "daily-rec-dot"), el("span", null, "Starting the microphone...")); }
    else if (voice.phase === "recording") {
      row.append(el("span", "daily-rec-dot on"), el("b", null, "Recording - speak now."), el("span", "daily-muted", kind === "shopping" ? "e.g. \"milk, eggs and two loaves of bread\"" : kind === "tasks" ? "e.g. \"renew the car insurance\"" : "e.g. \"dentist tomorrow at 5\""), el("span", "daily-sp"),
        btn("■ Stop", "daily-btn pri", stopVoice), btn("Cancel", "daily-btn", () => { cancelVoice(); render(); }));
    } else if (voice.phase === "transcribing") { row.append(el("span", "daily-rec-dot"), el("span", null, "Transcribing on this PC..."), el("span", "daily-sp"), btn("Cancel", "daily-btn", () => { cancelVoice(); render(); })); }
    else if (voice.phase === "error") {
      row.append(el("span", "daily-voice-err", voice.msg || "Something went wrong."), el("span", "daily-sp"),
        btn("Try again", "daily-btn", () => { voice = null; startVoice(kind); }), btn("Dismiss", "daily-btn", () => { voice = null; render(); }));
    } else if (voice.phase === "review") {
      row.append(el("span", "daily-muted", "You said: "), el("i", null, "“" + voice.text + "”"));
      box.append(row);
      box.append(kind === "shopping" ? shoppingReview(ctx) : taskReview());
      return box;
    }
    box.append(row);
    return box;
  }
  function shoppingReview(cur) {
    const rv = voice.review;
    const wrap = el("div", "daily-review");
    wrap.append(el("div", "daily-muted sm", `Check the items, fix anything wrong, then add them to ${cur.name}.`));
    const list = el("div", "daily-review-items");
    rv.items.forEach((text, i) => {
      const r = el("div", "daily-review-item");
      const inp = el("input", "daily-input grow"); inp.value = text; inp.maxLength = 200;
      inp.addEventListener("input", () => { rv.items[i] = inp.value; });
      const rm = btn("✕", "daily-btn sm", () => { rv.items.splice(i, 1); render(); }); rm.title = "Remove this item";
      r.append(inp, rm);
      list.append(r);
    });
    wrap.append(list);
    const acts = el("div", "daily-newlist");
    const n = rv.items.filter((x) => x.trim()).length;
    const save = btn(n ? `Add ${n} item${n === 1 ? "" : "s"} to ${cur.name}` : "Nothing to add", "daily-btn pri", async () => {
      const texts = rv.items.map((x) => x.trim()).filter(Boolean);
      if (!texts.length) return;
      const mine = voice;
      if ((cur.items || []).length >= ROW_CAP) showAllItems = true;
      const r = await api.shopping({ op: "add-many", listId: cur.id, texts, addedBy: "Voice" });
      if (r && r.ok) { if (voice === mine) voice = null; await after(r, `Added ${texts.length} item${texts.length === 1 ? "" : "s"} to ${cur.name}.`); } else say((r && r.reason) || "Could not add the items.");
    });
    if (!n) save.disabled = true;
    acts.append(save, btn("Cancel", "daily-btn", () => { voice = null; render(); }));
    wrap.append(acts);
    return wrap;
  }
  function taskReview() {
    const rv = voice.review;
    const wrap = el("div", "daily-review");
    wrap.append(el("div", "daily-muted sm", "Check the task, then save it. It is filed with the agent you pick."));
    const field = (label, node) => { const w = el("label", "daily-field"); w.append(el("span", "daily-muted", label), node); return w; };
    const title = el("input", "daily-input"); title.value = rv.title; title.maxLength = 200;
    title.addEventListener("input", () => { rv.title = title.value; });
    const agent = el("select", "daily-input");
    for (const a of rv.agents) { const o = el("option", null, a); o.value = a; if (a === rv.agent) o.selected = true; agent.append(o); }
    agent.addEventListener("change", () => { rv.agent = agent.value; });
    const area = el("div", "daily-seg");
    for (const a of ["Personal", "Business"]) area.append(btn(a, "daily-btn" + (rv.area === a ? " on" : ""), () => { rv.area = a; render(); }));
    const pri = el("select", "daily-input");
    for (let i = 10; i >= 1; i--) { const o = el("option", null, i === 10 ? "10 (highest)" : i === 1 ? "1 (lowest)" : String(i)); o.value = String(i); if (i === rv.priority) o.selected = true; pri.append(o); }
    pri.addEventListener("change", () => { rv.priority = Number(pri.value); });
    const list = el("input", "daily-input"); list.value = rv.list || ""; list.maxLength = 60; list.placeholder = "Optional list name, e.g. Home";
    list.addEventListener("input", () => { rv.list = list.value; });
    wrap.append(field("Task", title), field("Owner agent", agent), field("Area", area), field("Priority (1-10)", pri), field("List", list));
    const acts = el("div", "daily-newlist");
    acts.append(btn("Save task", "daily-btn pri", async () => {
      const mine = voice;
      const r = await api.addTask({ title: rv.title, agent: rv.agent, area: rv.area, priority: rv.priority, list: rv.list });
      if (r && r.ok) {
        if (voice === mine) voice = null;
        if (tf.area !== "all" && tf.area !== rv.area) tf.area = rv.area;   // make sure the new task is visible
        tf.status = "all"; if (tf.list && tf.list !== rv.list.trim()) tf.list = "";
        await after(r, `Task saved for ${rv.agent}.`);
      } else say((r && r.reason) || "Could not save the task.");
    }), btn("Cancel", "daily-btn", () => { voice = null; render(); }));
    wrap.append(acts);
    return wrap;
  }

  // ---------------------------------------------------------------- Tasks
  const tf = { area: "all", status: "all", list: "" };
  const STATUS_FILTERS = [["all", "All statuses"], ["needs", "Needs you"], ["working", "Working"], ["waiting", "Waiting"], ["queued", "Queued"]];
  const STATUS_PLAIN = { needs: "Needs you", working: "Working", waiting: "Waiting", queued: "Queued" };
  function filterTasks(tasks) {
    return tasks.filter((t) => (tf.area === "all" || t.area === tf.area) && (tf.status === "all" || t.status === tf.status) && (!tf.list || (t.list || "(no list)") === tf.list));
  }
  function renderTasks() {
    const all = payload.data.tasks || [];
    const wrap = el("div", "daily-plain");
    if (!all.length) { wrap.append(emptyState("No open tasks", "Tasks that agents file for you or work on show up here.", "Record a task ●", () => startVoice("tasks"))); const vp0 = voicePanel("tasks"); if (vp0) wrap.append(vp0); return wrap; }

    // row 1: area + status + Record
    const r1 = el("div", "daily-frow");
    const seg = el("div", "daily-seg");
    for (const [v, label] of [["all", "All"], ["Business", "Business"], ["Personal", "Personal"]]) {
      const sb = btn("", "daily-btn" + (tf.area === v ? " on" : ""), () => { tf.area = v; tf.list = ""; render(); });
      sb.append(el("span", null, label), el("span", "daily-n", String(areaCount(all, v))));
      seg.append(sb);
    }
    const stBtn = btn(`Status: ${tf.status === "all" ? "All" : STATUS_PLAIN[tf.status]} ▾`, "daily-btn pill daily-popper", () => {
      openPop(stBtn, (p) => {
        for (const [v, label] of STATUS_FILTERS) p.append(btn(label, "daily-pop-item" + (tf.status === v ? " on" : ""), () => { tf.status = v; closePop(); render(); }));
      });
    });
    const rec = recBtn("tasks", "daily-btn pri");
    const narrow = layout === "narrow";
    if (narrow) r1.append(seg); else r1.append(seg, stBtn, el("span", "daily-sp"), rec);
    wrap.append(r1);
    const vpT = voicePanel("tasks");

    // row 2: lists (counts follow the area and status filters)
    const lc = taskListCounts(all);
    const r2 = el("div", "daily-frow");
    if (narrow) {
      // narrow window (mockup 12): Status and a single Lists menu beside Record; the list chips would not fit
      const lb = btn("", "daily-btn pill daily-popper", () => openPop(lb, (p) => {
        const all = btn("", "daily-pop-item" + (!tf.list ? " on" : ""), () => { tf.list = ""; closePop(); render(); });
        all.append(el("span", null, "All lists"), el("span", "daily-muted", " " + lc.total));
        p.append(all);
        for (const l of lc.lists) { const b = btn("", "daily-pop-item" + (tf.list === l.name ? " on" : ""), () => { tf.list = l.name; closePop(); render(); }); b.append(el("span", null, l.name), el("span", "daily-muted", " " + l.count)); p.append(b); }
      }));
      lb.append(el("span", null, tf.list ? "List: " + tf.list + " ▾" : "Lists ▾"));
      if (lc.lists.length) lb.append(el("span", "daily-n", String(lc.lists.length)));
      r2.append(stBtn, lb, el("span", "daily-sp"), rec);
      wrap.append(r2);
    } else {
    r2.append(el("span", "daily-lbl", "LISTS"));
    const chip = (label, count, on, fn) => {
      const b = btn("", "daily-chip2" + (on ? " on" : ""), fn);
      b.append(el("span", null, label), el("span", "daily-n", String(count)));
      return b;
    };
    r2.append(chip("All lists", lc.total, !tf.list, () => { tf.list = ""; render(); }));
    let shown = lc.lists.slice(0, 3);
    if (tf.list && !shown.some((x) => x.name === tf.list)) { const sel = lc.lists.find((x) => x.name === tf.list); if (sel) shown = shown.slice(0, 2).concat(sel); }
    for (const l of shown) r2.append(chip(l.name, l.count, tf.list === l.name, () => { tf.list = l.name; render(); }));
    const rest = lc.lists.filter((x) => !shown.some((s) => s.name === x.name));
    if (rest.length) {
      const total = rest.reduce((a, x) => a + x.count, 0);
      const mb = btn("", "daily-chip2 daily-popper", () => {
        openPop(mb, (p) => { for (const l of rest) { const b = btn("", "daily-pop-item", () => { tf.list = l.name; closePop(); render(); }); b.append(el("span", null, l.name), el("span", "daily-muted", " " + l.count)); p.append(b); } });
      });
      mb.append(el("span", null, "More lists ▾"), el("span", "daily-n", String(total)));
      r2.append(mb);
    }
    wrap.append(r2);
    }

    if (vpT) wrap.append(vpT);
    // the list
    const rows = filterTasks(all).slice().sort((a, b) => b.priority - a.priority || b.ageDays - a.ageDays);
    const c = card("Open tasks", [el("span", "daily-sp"), el("span", "daily-muted daily-sort", "sorted by priority, 10 first")]);
    if (!rows.length) c.append(el("div", "daily-muted daily-pad", "No tasks match these filters."));
    const taskShown = showAllTasks ? rows : rows.slice(0, ROW_CAP);
    for (const t of taskShown) {
      const row = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      const meta = el("small", "daily-muted");
      meta.append(document.createTextNode(`${t.ageDays}d · ${t.agent} · `), el("span", "daily-scope " + (t.area === "Personal" ? "per" : "biz"), t.area));
      if (t.list) meta.append(document.createTextNode(" · "), el("span", "daily-cat", t.list));
      const ttl = el("div", "daily-ttl", t.title);
      ttl.addEventListener("click", () => { if (layout === "narrow") jumpToAgent(t.agent); });
      if (layout === "narrow") ttl.title = "Open " + t.agent;
      ti.append(ttl, meta);
      const pb = priBar(t.priority);
      pb.classList.add("daily-popper", "daily-clickable");
      pb.title = `Priority ${t.priority} of 10 - click to change`;
      pb.addEventListener("click", () => openPop(pb, (p) => {
        p.classList.add("daily-pop-pri");
        for (let i = 10; i >= 1; i--) {
          const sw = btn(String(i), "daily-sw" + (i === t.priority ? " cur" : ""), async () => { closePop(); await after(await api.editTask({ agent: t.agent, id: t.id, priority: i }), `Priority set to ${i}.`); });
          sw.style.background = PRI_COLORS[i - 1];
          p.append(sw);
        }
      }));
      const st = btn(STATUS_LABEL[t.status], "daily-st daily-popper " + STATUS_CLASS[t.status], () => openPop(st, (p) => {
        for (const k of ["needs", "working", "waiting", "queued"]) {
          p.append(btn(STATUS_LABEL[k], "daily-pop-item" + (k === t.status ? " on" : ""), async () => { closePop(); if (k !== t.status) await after(await api.editTask({ agent: t.agent, id: t.id, status: k }), `Status set to ${STATUS_PLAIN[k]}.`); }));
        }
      }));
      st.title = "Click to change the status";
      row.append(ti, pb, st, btn("Open", "daily-btn sm", () => jumpToAgent(t.agent)));
      c.append(row);
    }
    if (rows.length > taskShown.length) c.append(moreRow(rows.length, taskShown.length, "tasks", () => { showAllTasks = true; render(); }));
    wrap.append(c);
    const lg = el("section", "daily-card daily-legendcard");
    const l1 = legendPriority();
    l1.style.marginTop = "0";
    lg.append(l1);
    wrap.append(lg);
    return wrap;
  }
  const areaCount = (tasks, v) => (v === "all" ? tasks.length : tasks.filter((t) => t.area === v).length);
  function taskListCounts(tasks) {
    const base = tasks.filter((t) => (tf.area === "all" || t.area === tf.area) && (tf.status === "all" || t.status === tf.status));
    const m = new Map();
    for (const t of base) { const k = t.list || "(no list)"; m.set(k, (m.get(k) || 0) + 1); }
    return { total: base.length, lists: Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
  }

  // ---------------------------------------------------------------- Shopping lists
  const thumbCache = new Map();   // file name -> data URL
  // Very long lists draw the first ROW_CAP rows (highest priority / newest first) and a "Show all" row, so a
  // 5,000-item list or 2,000 tasks never builds tens of thousands of DOM nodes unasked.
  const ROW_CAP = 200;
  let showAllTasks = false, showAllItems = false;
  function moreRow(total, shown, what, onClick) {
    const r = el("div", "daily-more-row");
    const sb = btn(`Show all ${total}`, "daily-btn sm daily-showall", onClick);   // a real <button>: Tab reaches it, Enter and Space activate it
    r.append(el("span", "daily-muted", `Showing ${shown} of ${total} ${what}. `), sb);
    return r;
  }
  function relDay(iso, now) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const a = new Date(now); a.setHours(0, 0, 0, 0);
    const b = new Date(t); b.setHours(0, 0, 0, 0);
    const d = Math.round((a - b) / 86400000);
    return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
  }
  const doneText = (iso, now) => { const r = relDay(iso, now); return `done ${r === "today" ? "today" : r === "yesterday" ? "yesterday " + clock(Date.parse(iso)) : new Date(iso).getDate() + " " + MONTHS[new Date(iso).getMonth()]}`; };
  function copyText(text) {
    const fallback = () => { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) { /* ignore */ } ta.remove(); };
    try { navigator.clipboard.writeText(text).catch(fallback); } catch (e) { fallback(); }
  }
  let selList = null;
  function renderShopping() {
    const lists = payload.data.shopping.lists || [];
    const create = () => { newListOpen = true; render(); };
    const form = () => {
      const row = el("div", "daily-newlist");
      const inp = el("input", "daily-input");
      inp.placeholder = "List name, for example Groceries";
      inp.maxLength = 60;
      const go = async () => {
        const r = await api.createShoppingList(inp.value);
        if (!r.ok) { say(r.reason || "Could not create the list."); return; }
        newListOpen = false;
        await load(true);
        const made = ((payload.data.shopping.lists) || []).find((l) => l.name.toLowerCase() === inp.value.trim().toLowerCase());
        if (made) selList = made.id;
        render();
      };
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") { newListOpen = false; render(); } });
      row.append(inp, btn("Create", "daily-btn pri", go), btn("Cancel", "daily-btn", () => { newListOpen = false; render(); }));
      setTimeout(() => inp.focus(), 0);
      return row;
    };
    if (!lists.length) {
      const e = emptyState("No shopping lists yet", "Create a list for groceries, the studio, or anything else you buy for.", newListOpen ? null : "+ New list", create);
      if (newListOpen) e.append(form());
      return e;
    }
    if (!lists.some((l) => l.id === selList)) selList = lists[0].id;
    const cur = lists.find((l) => l.id === selList);
    const now = payload.now;
    const wrap = el("div", "daily-shop");

    // left: my lists
    const left = el("section", "daily-card daily-shop-l");
    left.append(card("My lists", [num(lists.length, "", "Lists")]).firstChild);
    for (const l of lists) {
      const n = (l.items || []).filter((i) => !i.doneAt && !i.archivedAt).length;
      const b = btn("", "daily-listbtn" + (l.id === selList ? " on" : ""), () => { selList = l.id; render(); });
      b.append(el("span", null, l.name));
      if (n) b.append(el("span", "daily-n", String(n)));
      left.append(b);
    }
    left.append(btn("+ New list", "daily-btn daily-newbtn", create));
    if (newListOpen) left.append(form());

    // right: the selected list
    const right = el("section", "daily-card daily-shop-r");
    const items = cur.items || [];
    const open = items.filter((i) => !i.archivedAt);
    const openN = items.filter((i) => !i.doneAt && !i.archivedAt).length;
    const h = el("h3", "daily-card-h");
    h.append(el("span", null, cur.name));
    if (openN) h.append(el("span", "daily-n", String(openN)));
    h.append(el("span", "daily-sp"));
    const share = async () => { const r = await api.shopping({ op: "share", listId: cur.id }); if (r && r.ok) { copyText(r.text); say("List copied as plain text. Paste it into a message to Merav (sending from here is not built yet)."); } else say((r && r.reason) || "Could not share."); };
    h.append(btn("Send to Merav", "daily-btn sm", share), btn("Share list", "daily-btn sm", share));
    right.append(h);

    const addRow = el("div", "daily-addrow");
    const inp = el("input", "daily-input grow");
    inp.placeholder = "Add an item by typing";
    inp.maxLength = 200;
    const add = async () => { const v = inp.value.trim(); if (!v) return; if (open.length >= ROW_CAP) showAllItems = true; await after(await api.shopping({ op: "add", listId: cur.id, text: v, addedBy: "Me" })); const i2 = body.querySelector(".daily-shop-r input"); if (i2) i2.focus(); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    addRow.append(inp, btn("Add", "daily-btn pri", add), recBtn("shopping", "daily-btn"));
    const vpS = voicePanel("shopping", cur);
    const linkRow = el("div", "daily-addrow");
    const link = el("input", "daily-input grow");
    link.placeholder = "or paste a product link (Amazon, B&H, AliExpress, eBay)";
    const addLink = async () => {
      const v = link.value.trim();
      if (!v) return;
      if (open.length >= ROW_CAP) showAllItems = true;   // a new item lands at the end: make sure it is visible
      lb.disabled = true; lb.textContent = "Reading the page...";
      const r = await api.shopping({ op: "add-link", listId: cur.id, url: v, addedBy: "Me" });
      lb.disabled = false; lb.textContent = "Add from link";
      if (r && r.ok) { await after(r, r.detailsMissing ? "Added with the link only - details not found on that page." : "Added from the link."); }
      else say((r && r.reason) || "Could not add that link.");
    };
    const lb = btn("Add from link", "daily-btn pri", addLink);
    link.addEventListener("keydown", (e) => { if (e.key === "Enter") addLink(); });
    linkRow.append(link, lb);
    right.append(addRow);
    if (vpS) right.append(vpS);
    right.append(linkRow);

    const need = open.slice(0, showAllItems ? open.length : ROW_CAP).filter((i) => i.thumb && !thumbCache.has(i.thumb)).map((i) => i.thumb).concat(items.filter((i) => i.archivedAt && i.thumb && !thumbCache.has(i.thumb)).slice(0, ROW_CAP).map((i) => i.thumb)).slice(0, 100);
    if (need.length) api.thumbs(need).then((m) => { let any = false; for (const k of Object.keys(m || {})) { thumbCache.set(k, m[k]); any = true; } if (any && isOpen() && tab === "shopping") render(); }).catch(() => {});

    if (!open.length) right.append(el("div", "daily-muted daily-pad", "This list is empty. Add something above."));
    const openShown = showAllItems ? open : open.slice(0, ROW_CAP);
    for (const it of openShown) {
      const row = el("div", "daily-item" + (it.doneAt ? " done" : ""));
      const ck = el("button", "daily-ck" + (it.doneAt ? " on" : ""), it.doneAt ? "✓" : "");
      ck.type = "button";
      ck.title = it.doneAt ? "Ticked - click to undo (it moves to the archive after 1 hour)" : "Tick when bought";
      ck.addEventListener("click", async () => { await after(await api.shopping({ op: it.doneAt ? "untick" : "tick", listId: cur.id, itemId: it.id })); });
      const tx = el("div", "daily-ti");
      const t1 = el("div", "daily-item-t");
      t1.append(el("span", it.doneAt ? "daily-strike" : "", it.text));
      if (it.link && /^https:\/\//i.test(it.link)) {
        let host = it.source || "link";
        try { host = new URL(it.link).hostname.replace(/^www\./, ""); } catch (e) { /* keep tag */ }
        const a = btn("↗ " + host, "daily-linkbtn", () => window.open(it.link));
        a.title = "Open the product page in your browser";
        t1.append(document.createTextNode(" "), a);
      }
      const meta = el("small", "daily-muted");
      if (it.doneAt) meta.append(document.createTextNode(`done ${relDay(it.doneAt, now)}`));
      else {
        meta.append(document.createTextNode(`added ${relDay(it.added, now)}${it.addedBy ? " · " + it.addedBy : ""}`));
        if (it.fromLink) {
          meta.append(document.createTextNode(" · from link"));
          if (it.source) meta.append(document.createTextNode(" · "), el("span", "daily-acct", it.source));
          if (it.price) meta.append(document.createTextNode(" · " + it.price));
          if (it.detailsMissing) meta.append(document.createTextNode(" · details not found"));
        }
      }
      tx.append(t1, meta);
      row.append(ck, tx);
      if (it.thumb && thumbCache.has(it.thumb)) {
        const im = document.createElement("img");
        im.className = "daily-thumb";
        im.alt = "";
        im.src = thumbCache.get(it.thumb);
        row.append(im);
      } else if (it.fromLink) {
        row.append(el("span", "daily-thumb ph", (it.source || "link").slice(0, 10)));
      }
      right.append(row);
    }
    if (open.length > openShown.length) right.append(moreRow(open.length, openShown.length, "items", () => { showAllItems = true; render(); }));
    right.append(el("div", "daily-hint", "Tick items off in the shop. A ticked item stays for 1 hour (so a mis-tap is easy to undo), then moves to this list's Archive."));

    // archive
    const arch = items.filter((i) => i.archivedAt).sort((a, b) => Date.parse(b.doneAt || b.archivedAt) - Date.parse(a.doneAt || a.archivedAt));
    if (arch.length) {
      const ac = el("section", "daily-card daily-archive");
      const ah = el("h3", "daily-card-h");
      ah.append(el("span", null, `Archive of ${cur.name}`), el("span", "daily-n", String(arch.length)), el("span", "daily-sp"), el("span", "daily-muted daily-sort", "kept 90 days"));
      ac.append(ah);
      for (const it of (showAllItems ? arch : arch.slice(0, ROW_CAP))) {
        const row = el("div", "daily-item");
        const tx = el("div", "daily-ti");
        tx.append(el("div", "daily-strike", it.text), el("small", "daily-muted", doneText(it.doneAt || it.archivedAt, now)));
        row.append(tx, btn("Bring back", "daily-btn sm", async () => { await after(await api.shopping({ op: "bring-back", listId: cur.id, itemId: it.id }), "Back on the list."); }));
        ac.append(row);
      }
      if (arch.length > ROW_CAP && !showAllItems) ac.append(moreRow(arch.length, ROW_CAP, "archived items", () => { showAllItems = true; render(); }));
      right.append(ac);
    }
    wrap.append(left, right);
    return wrap;
  }

  // ---------------------------------------------------------------- Birthdays & dates
  let dateForm = null;   // null = closed; otherwise the item being edited ({} for a new one)
  const DATE_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function renderDates() {
    const items = (payload.data.dates || []).filter((x) => x && x.month >= 1 && x.month <= 12);
    const wrap = el("div", "daily-datesrow");
    const left = el("section", "daily-card daily-dates-l");
    const lh = el("h3", "daily-card-h");
    const up = upcoming(items, payload.now);
    lh.append(el("span", null, "Coming up"));
    if (up.length) lh.append(el("span", "daily-n", String(up.length)));
    lh.append(el("span", "daily-sp"), btn("+ Add birthday or date", "daily-btn pri sm", () => { dateForm = { kind: "birthday", repeat: true, showOnSchedule: true, remindDays: 3 }; render(); }));
    left.append(lh);
    if (!up.length) left.append(el("div", "daily-muted daily-pad", "No birthdays or dates yet. Add the first one."));
    for (const x of up) {
      const row = el("div", "daily-datarow");
      const when = el("div", "daily-dwhen");
      when.append(el("span", null, `${x.day} ${MONTHS[x.month - 1]}`), el("small", null, x.inDays === 0 ? "today" : `in ${x.inDays} d`));
      row.append(when);
      const mid = el("div", "daily-ti");
      mid.append(el("div", null, x.title), el("small", "daily-muted", `${x.kind === "birthday" ? "Birthday" : "Date"}${x.repeat === false ? " · one-off" : ""}${x.note ? " · " + x.note : ""}${x.showOnSchedule !== false ? " · shown on Schedule" : ""}`));
      row.append(mid, btn("Edit", "daily-btn sm", () => { dateForm = Object.assign({}, x); render(); }));
      left.append(row);
    }
    wrap.append(left);
    if (dateForm) wrap.append(dateEditor());
    const lg = scheduleLegend();
    const out = el("div", "daily-plain");
    out.append(wrap, lg);
    return out;
  }
  // Next occurrence of each date, nearest first (one-off dates in the past are dropped).
  function upcoming(items, now) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const out = [];
    for (const x of items) {
      let d;
      if (x.repeat === false && x.year) d = new Date(x.year, x.month - 1, x.day);
      else { d = new Date(today.getFullYear(), x.month - 1, x.day); if (d < today) d = new Date(today.getFullYear() + 1, x.month - 1, x.day); }
      const inDays = Math.round((d - today) / 86400000);
      if (inDays >= 0) out.push(Object.assign({}, x, { inDays }));
    }
    return out.sort((a, b) => a.inDays - b.inDays);
  }
  function dateEditor() {
    const f = dateForm;
    const side = el("section", "daily-card daily-dates-r");
    side.append(el("h3", "daily-card-h", f.id ? "Edit" : "Add a new one"));
    const field = (label, node) => { const w = el("label", "daily-field"); w.append(el("span", "daily-muted", label), node); return w; };
    const name = el("input", "daily-input");
    name.value = f.title || ""; name.placeholder = "Yossi, birthday"; name.maxLength = 100;
    const date = el("input", "daily-input");
    date.type = "date";
    if (f.month) date.value = `${f.year || new Date(payload.now).getFullYear()}-${pad2(f.month)}-${pad2(f.day)}`;
    const mk = (label, key) => { const l = el("label", "daily-check"); const c = document.createElement("input"); c.type = "checkbox"; c.checked = f[key] !== false; l.append(c, document.createTextNode(label)); return [l, c]; };
    const [repL, rep] = mk("Repeat every year", "repeat");
    const [schL, sch] = mk("Show on Schedule", "showOnSchedule");
    const kind = document.createElement("select"); kind.className = "daily-input";
    for (const [v, l] of [["birthday", "Birthday"], ["date", "Other date"]]) { const o = document.createElement("option"); o.value = v; o.textContent = l; kind.append(o); }
    kind.value = f.kind || "birthday";
    const rem = document.createElement("select"); rem.className = "daily-input";
    for (const [v, l] of [[0, "On the day"], [1, "1 day before"], [3, "3 days before"], [7, "1 week before"], [14, "2 weeks before"]]) { const o = document.createElement("option"); o.value = String(v); o.textContent = l; rem.append(o); }
    rem.value = String(f.remindDays != null ? f.remindDays : 3);
    side.append(field("Name or occasion", name), field("Date", date), field("Type", kind), repL, schL, field("Remind me", rem));
    const acts = el("div", "daily-newlist");
    const save = async () => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.value);
      if (!m) { say("Pick a date."); return; }
      const item = { id: f.id, title: name.value, year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), kind: kind.value, repeat: rep.checked, showOnSchedule: sch.checked, remindDays: Number(rem.value), note: f.note, agent: f.agent };
      if (rep.checked) delete item.year;
      const r = await api.saveDate(item);
      if (r && r.ok) { dateForm = null; await load(true); render(); } else say((r && r.reason) || "Could not save.");
    };
    acts.append(btn("Save", "daily-btn pri", save), btn("Cancel", "daily-btn", () => { dateForm = null; render(); }));
    if (f.id) acts.append(btn("Delete", "daily-btn", async () => { if (!confirm("Delete this date?")) return; const r = await api.deleteDate(f.id); if (r && r.ok) { dateForm = null; await load(true); render(); } else say((r && r.reason) || "Could not delete."); }));
    side.append(acts);
    setTimeout(() => name.focus(), 0);
    return side;
  }

  // ---------------------------------------------------------------- Emails (placeholder provider only)
  let emailAcct = "all";
  const DAY_MS = 86400000;
  const shortDate = (ms) => `${new Date(ms).getDate()} ${MONTHS[new Date(ms).getMonth()]}`;
  const NOT_CONNECTED_DEMO = "Email is not connected yet, so this is demo data. Reading and replying arrive when it is connected.";
  const NOT_CONNECTED_READONLY = "This feed is read-only for now: replying and reminders arrive later.";
  function dayBadge(days) {
    const b = el("span", "daily-dayb " + waitCls(days), `${days} d`);
    b.title = `${days} day${days === 1 ? "" : "s"} waiting`;
    return b;
  }
  const waitCls = (d) => window.dailySchedule.waitClass(d);
  function renderEmails() {
    const em = payload.data.emails || { top: [], needAnswer: [], sentNoReply: [], peopleToWrite: [] };
    const accounts = payload.provider.accounts || [];
    const now = payload.now;
    const wrap = el("div", "daily-plain");
    if (!payload.provider.connected) wrap.append(demoBanner("emails"));

    // accounts row: counts = items that need attention per account
    const counts = {};
    for (const a of accounts) counts[a] = 0;
    for (const x of em.needAnswer || []) counts[x.account] = (counts[x.account] || 0) + 1;
    for (const x of em.sentNoReply || []) if (x.ageDays >= 3) counts[x.account] = (counts[x.account] || 0) + 1;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const row = el("div", "daily-frow");
    row.append(el("span", "daily-lbl", "ACCOUNTS"));
    const chip = (label, n, id) => {
      const b = btn("", "daily-chip2" + (emailAcct === id ? " on" : ""), () => { emailAcct = id; render(); });
      b.append(el("span", null, label));
      if (n) b.append(el("span", "daily-n", String(n)));
      b.title = `Show ${id === "all" ? "all accounts" : label}`;
      return b;
    };
    row.append(chip("All", total, "all"));
    for (const a of accounts) row.append(chip(a, counts[a], a));
    row.append(el("span", "daily-sp"));
    if (em.hidden) row.append(el("span", "daily-muted sm", `${em.hidden} promotions and spam hidden`));
    wrap.append(row);

    const by = (list) => (emailAcct === "all" ? list || [] : (list || []).filter((x) => x.account === emailAcct));
    const notYet = () => say(payload.provider.emailsConnected ? NOT_CONNECTED_READONLY : NOT_CONNECTED_DEMO);
    const meta = (lead, acct, tail) => {
      const m = el("small", "daily-muted");
      m.append(document.createTextNode(lead ? lead + " · " : ""), el("span", "daily-acct", acct), document.createTextNode(tail ? " · " + tail : ""));
      return m;
    };
    const mk = (title, n, cls, sub2) => {
      const c = el("section", "daily-card");
      const h = el("h3", "daily-card-h");
      h.append(el("span", null, title));
      if (n) h.append(num(n, cls, `Show the ${n} below`, () => c.scrollIntoView({ block: "nearest", behavior: "smooth" })));
      h.append(el("span", "daily-sp"));
      if (sub2) h.append(el("span", "daily-muted sm daily-nocaps", sub2));
      c.append(h);
      return c;
    };
    const none = (c, t) => c.append(el("div", "daily-muted daily-pad", t));

    const top = by(em.top);
    const c1 = mk("1. Today's top emails", top.length, "blue", "most important first");
    if (!top.length) none(c1, "No important email today.");
    for (const m of top) {
      const r = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      ti.append(el("div", null, m.subject), meta(m.from, m.account, clock(m.at)));
      const imp = el("span", "daily-imp", "●".repeat(m.importance) + "○".repeat(3 - m.importance) + " " + (IMP_LABEL[m.importance] || ""));
      imp.title = `Importance ${m.importance} of 3`;
      r.append(ti, imp, btn("Open", "daily-btn sm", notYet));
      c1.append(r);
    }
    const na = by(em.needAnswer);
    const c2 = mk("2. Open, needs your answer", na.length, "warn");
    if (!na.length) none(c2, "Nothing is waiting for your answer.");
    for (const m of na) {
      const r = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      ti.append(el("div", null, m.subject), meta(m.from, m.account, "received " + shortDate(now - m.ageDays * DAY_MS)));
      r.append(ti, dayBadge(m.ageDays), btn("Reply", "daily-btn sm", notYet));
      c2.append(r);
    }
    const sn = by(em.sentNoReply);
    const c3 = mk("3. Sent, no reply yet", sn.length, "warn");
    if (!sn.length) none(c3, "Everything you sent has an answer.");
    for (const m of sn) {
      const r = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      ti.append(el("div", null, m.subject), meta(m.to ? "To " + m.to : "", m.account, "sent " + shortDate(now - m.ageDays * DAY_MS)));
      r.append(ti, dayBadge(m.ageDays), btn("Draft reminder", "daily-btn sm" + (m.ageDays >= 3 ? " pri" : ""), notYet));
      c3.append(r);
    }
    c3.append(el("div", "daily-leg", "\"Draft reminder\" opens a ready follow-up to the recipient for you to edit and send. Nothing is sent by itself."));
    const pw = em.peopleToWrite || [];
    const c4 = mk("4. People to write to", pw.length, "", "optional section");
    if (!pw.length) none(c4, "No one to write to.");
    for (const w of pw) {
      const r = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      ti.append(el("div", null, w.text), el("small", "daily-muted", `added by ${w.by} · ${w.ageDays}d`));
      r.append(ti, btn("Write", "daily-btn sm", notYet));
      c4.append(r);
    }
    const cols = el("div", "daily-two daily-emailcols");
    const l = el("div", "daily-col"); l.append(c1, c2);
    const r = el("div", "daily-col"); r.append(c3, c4);
    cols.append(l, r);
    wrap.append(cols);
    const lg = el("section", "daily-card daily-legendcard daily-wlegend");
    lg.append(el("b", null, "Days waiting"), el("span", "daily-g", "1-2 d grey"), el("span", "daily-g d3", "3-4 d amber"), el("span", "daily-g d5", "5+ d red"), el("span", "daily-muted", "(the number is always shown)"));
    wrap.append(lg);
    return wrap;
  }
  const IMP_LABEL = { 3: "High", 2: "Med", 1: "Low" };

  // ---------------------------------------------------------------- Schedule
  let sv = "month";          // day | week | month | six
  let cursor = null;         // ms; the day/week/month being shown
  let apptForm = null;       // null = closed; {} or an own appointment being edited
  const CAL_LABEL = { iddo: "Mine", merav: "Added by Merav", bday: "Birthday / date", google: "Google Calendar" };
  const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function scheduleLegend() {
    const lg = el("div", "daily-legendcard daily-card daily-datesleg");
    lg.append(el("b", null, "Schedule"));
    for (const cls of ["iddo", "merav", "bday", "google"]) {
      const s = el("span", "daily-leg-item");
      s.append(el("span", "daily-sw2 " + cls), document.createTextNode(CAL_LABEL[cls]));
      lg.append(s);
    }
    return lg;
  }
  const dKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  function entryText(e, withTime) {
    return e.kind === "appt" && withTime ? `${clock(e.start)} ${e.title}` : e.title;
  }
  function renderSchedule() {
    const now = payload.now;
    if (cursor == null) cursor = now;
    const cur = new Date(cursor);
    const wrap = el("div", "daily-plain daily-sched");
    if (!payload.provider.connected) wrap.append(demoBanner());

    const bar = el("div", "daily-frow");
    const seg = el("div", "daily-seg");
    for (const [v, label] of [["day", "Day"], ["week", "Week"], ["month", "Month"], ["six", "6 months"]]) {
      seg.append(btn(label, "daily-btn" + (sv === v ? " on" : ""), () => { sv = v; render(); }));
    }
    const shift = (dir) => {
      const d = new Date(cursor);
      if (sv === "day") d.setDate(d.getDate() + dir);
      else if (sv === "week") d.setDate(d.getDate() + 7 * dir);
      else if (sv === "month") d.setMonth(d.getMonth() + dir, 1);
      else d.setMonth(d.getMonth() + 6 * dir, 1);
      cursor = d.getTime();
      render();
    };
    const wk0 = new Date(cur); wk0.setDate(cur.getDate() - cur.getDay());
    const wk6 = new Date(wk0); wk6.setDate(wk0.getDate() + 6);
    const six = new Date(cur.getFullYear(), cur.getMonth() + 5, 1);
    const title = sv === "day" ? `${WEEKDAYS[cur.getDay()]} ${cur.getDate()} ${MONTHS[cur.getMonth()]} ${cur.getFullYear()}`
      : sv === "week" ? `${wk0.getDate()} ${MONTHS[wk0.getMonth()]} – ${wk6.getDate()} ${MONTHS[wk6.getMonth()]} ${wk6.getFullYear()}`
      : sv === "month" ? `${DATE_LONG[cur.getMonth()]} ${cur.getFullYear()}`
      : `${MONTHS[cur.getMonth()]} ${cur.getFullYear()} – ${MONTHS[six.getMonth()]} ${six.getFullYear()}`;
    const prev = btn("‹", "daily-btn sm", () => shift(-1)); prev.title = "Previous";
    const next = btn("›", "daily-btn sm", () => shift(1)); next.title = "Next";
    bar.append(seg, prev, el("b", "daily-sched-title", title), next, btn("Today", "daily-btn sm", () => { cursor = now; render(); }), el("span", "daily-sp"),
      recBtn("schedule", "daily-btn", "Record by voice ●"));
    wrap.append(bar);
    const add = el("div", "daily-frow");
    add.append(btn("+ Add appointment", "daily-btn pri", () => { apptForm = { start: sv === "six" ? now : cursor }; render(); }));
    wrap.append(add);
    const vpA = voicePanel("schedule");
    if (vpA) wrap.append(vpA);

    const events = payload.data.events || [], dates = payload.data.dates || [];
    const openEntry = (e) => {
      if (e.kind === "appt" && e.own) { apptForm = Object.assign({}, e); render(); }
      else { cursor = e.start || cursor; sv = "day"; render(); }
    };
    const gotoDay = (d) => { cursor = d.getTime ? d.getTime() : d; sv = "day"; render(); };
    const rowFor = (e) => {
      const r = el("div", "daily-ev");
      r.append(el("span", "daily-tm", e.kind === "appt" ? `${clock(e.start)}–${clock(e.end || e.start)}` : e.dateKind === "birthday" ? "Birthday" : "Date"));
      const t = el("span", "daily-ev-t");
      t.append(el("span", "daily-sw2 " + (e.cal || "iddo")), document.createTextNode(" " + e.title));
      if (e.leaveBy) t.append(el("small", "daily-muted", " · leave by " + e.leaveBy));
      if (e.location) t.append(el("small", "daily-muted", " · " + e.location));
      r.append(t);
      if (e.own) r.append(el("span", "daily-sp"), btn("Edit", "daily-btn sm", () => openEntry(e)));
      return r;
    };

    if (sv === "month") {
      const weeks = monthGridLocal(cur.getFullYear(), cur.getMonth() + 1);
      const from = new Date(weeks[0][0].year, weeks[0][0].month - 1, weeks[0][0].day).getTime();
      const lastC = weeks[weeks.length - 1][6];
      const map = scheduleEntriesLocal(events, dates, from, new Date(lastC.year, lastC.month - 1, lastC.day + 1).getTime());
      const grid = el("div", "daily-mon");
      for (const w of WEEKDAYS) grid.append(el("div", "daily-mon-h", w));
      const todayKey = dKey(new Date(now));
      for (const week of weeks) for (const c of week) {
        const cell = el("div", "daily-mon-c" + (c.inMonth ? "" : " out") + (c.key === todayKey ? " today" : ""));
        cell.addEventListener("click", () => gotoDay(new Date(c.year, c.month - 1, c.day)));
        cell.append(el("b", null, String(c.day)));
        const list = map.get(c.key) || [];
        for (const e of list.slice(0, 2)) {
          const ch = el("span", "daily-chipx " + (e.cal || "iddo"), entryText(e, true));
          ch.title = e.title;
          ch.addEventListener("click", (ev) => { ev.stopPropagation(); openEntry(e); });
          cell.append(ch);
        }
        if (list.length > 2) { const more = el("span", "daily-more", `+${list.length - 2} more`); more.setAttribute("role", "button"); cell.append(more); }
        grid.append(cell);
      }
      wrap.append(grid);
    } else if (sv === "six") {
      const months = sixMonthsLocal(events, dates, cur.getFullYear(), cur.getMonth() + 1);
      const g = el("div", "daily-six");
      const tn = new Date(now), todayNum = tn.getFullYear() * 10000 + (tn.getMonth() + 1) * 100 + tn.getDate();
      for (const m of months) {
        const c = el("section", "daily-card daily-mini");
        const h = el("h4", "daily-mini-h");
        h.append(el("b", null, DATE_LONG[m.month - 1] + (m.year !== cur.getFullYear() ? " " + m.year : "")));
        if (m.count) h.append(num(m.count, "", `${m.count} entr${m.count === 1 ? "y" : "ies"} in ${DATE_LONG[m.month - 1]} - open the month`, () => { cursor = new Date(m.year, m.month - 1, 1).getTime(); sv = "month"; render(); }));
        h.addEventListener("click", () => { cursor = new Date(m.year, m.month - 1, 1).getTime(); sv = "month"; render(); });
        c.append(h);
        const mg = el("div", "daily-minigrid");
        const lead = new Date(m.year, m.month - 1, 1).getDay();
        for (let i = 0; i < lead; i++) mg.append(el("span"));
        const dim = new Date(m.year, m.month, 0).getDate();
        for (let d = 1; d <= dim; d++) {
          const k = m.days[d];
          const s = el("span", "daily-minid" + (k ? " has " + k : "") + (m.year * 10000 + m.month * 100 + d === todayNum ? " today" : ""), String(d));
          if (m.year * 10000 + m.month * 100 + d === todayNum) s.title = "Today";
          if (k) { s.setAttribute("role", "button"); s.addEventListener("click", () => gotoDay(new Date(m.year, m.month - 1, d))); }
          mg.append(s);
        }
        c.append(mg);
        g.append(c);
      }
      wrap.append(g);
      wrap.append(el("div", "daily-muted sm", "Blue = appointment, pink = birthday or date. Click a day or a month to open it."));
    } else if (sv === "week") {
      const from = new Date(wk0.getFullYear(), wk0.getMonth(), wk0.getDate()).getTime();
      const map = scheduleEntriesLocal(events, dates, from, new Date(wk0.getFullYear(), wk0.getMonth(), wk0.getDate() + 7).getTime());
      for (let i = 0; i < 7; i++) {
        const d = new Date(wk0.getFullYear(), wk0.getMonth(), wk0.getDate() + i);
        const list = map.get(dKey(d)) || [];
        const c = el("section", "daily-card daily-weekday" + (dKey(d) === dKey(new Date(now)) ? " today" : ""));
        const h = el("h3", "daily-card-h");
        h.append(el("span", null, `${WEEKDAY_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`));
        if (list.length) h.append(num(list.length, "", "Open this day", () => gotoDay(d)));
        c.append(h);
        if (!list.length) c.append(el("div", "daily-muted sm", "Nothing scheduled."));
        for (const e of list) c.append(rowFor(e));
        wrap.append(c);
      }
    } else {
      const from = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()).getTime();
      const list = (scheduleEntriesLocal(events, dates, from, new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1).getTime()).get(dKey(cur))) || [];
      const c = el("section", "daily-card");
      const h = el("h3", "daily-card-h");
      h.append(el("span", null, `${WEEKDAY_LONG[cur.getDay()]} ${cur.getDate()} ${DATE_LONG[cur.getMonth()]}`));
      if (list.length) h.append(num(list.length, "", `${list.length} on this day`));
      c.append(h);
      if (!list.length) c.append(el("div", "daily-muted daily-pad", "Nothing scheduled this day."));
      for (const e of list) c.append(rowFor(e));
      wrap.append(c);
    }
    wrap.append(scheduleLegend());
    if (apptForm) wrap.append(apptEditor());
    return wrap;
  }
  const monthGridLocal = (y, m) => window.dailySchedule.monthGrid(y, m);
  const scheduleEntriesLocal = (...a) => window.dailySchedule.scheduleEntries(...a);
  const sixMonthsLocal = (...a) => window.dailySchedule.sixMonths(...a);

  function apptEditor() {
    const f = apptForm;
    const box = el("section", "daily-card daily-appt");
    const h = el("h3", "daily-card-h");
    h.append(el("span", null, f.id ? "Edit appointment" : "Add appointment"), el("span", "daily-sp"));
    const rec = el("button", "daily-linkbtn", "or record by voice");
    rec.type = "button";
    rec.addEventListener("click", () => { snap(); startVoice("schedule"); });
    h.append(rec);
    box.append(h);
    if (f.voiceText) {
      const vn = el("div", "daily-voice-note");
      vn.append(el("span", "daily-muted", "Filled in from your recording: "), el("i", null, "\u201c" + f.voiceText + "\u201d"));
      vn.append(el("div", null, (f.voiceMissing && f.voiceMissing.length ? `I did not catch the ${f.voiceMissing.join(" or ")} - please set it. ` : "") + "Check everything, then press Save to calendar. Nothing is saved until you do."));
      box.append(vn);
    }
    const field = (label, node) => { const w = el("label", "daily-field"); w.append(el("span", "daily-muted", label), node); return w; };
    const st = new Date(f.start || payload.now);
    const en = new Date(f.end || (st.getTime() + 3600000));
    const date = el("input", "daily-input"); date.type = "date"; date.value = dKey(st);
    const t1 = el("input", "daily-input"); t1.type = "time"; t1.value = f.id || f.end ? clock(st.getTime()) : "09:00";
    const t2 = el("input", "daily-input"); t2.type = "time"; t2.value = f.id || f.end ? clock(en.getTime()) : "10:00";
    const dt = el("div", "daily-dtrow"); dt.append(date, t1, el("span", "daily-muted", "–"), t2);
    const who = el("input", "daily-input"); who.value = f.who || ""; who.maxLength = 100; who.placeholder = "Who or what";
    const notes = el("textarea", "daily-input"); notes.rows = 2; notes.value = f.notes || ""; notes.maxLength = 500; notes.placeholder = "Anything worth remembering about the person";
    const contact = el("input", "daily-input"); contact.value = f.contact || ""; contact.maxLength = 200; contact.placeholder = "Phone and email";
    const loc = el("textarea", "daily-input"); loc.rows = 2; loc.value = f.location || ""; loc.maxLength = 300; loc.placeholder = "Where, and where exactly to meet";
    const ckL = el("label", "daily-check"); const ck = document.createElement("input"); ck.type = "checkbox"; ck.checked = f.shareMerav !== false;
    ckL.append(ck, document.createTextNode("Merav can see this entry"));
    box.append(field("Date and time", dt), field("Who", who), field("Notes on the person", notes), field("Contact details", contact), field("Location and meeting place", loc), ckL);
    const acts = el("div", "daily-newlist");
    // keep what was typed when a recording replaces the form (Record from inside the form)
    const snap = () => {
      f.who = who.value; f.notes = notes.value; f.contact = contact.value; f.location = loc.value; f.shareMerav = ck.checked;
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.value), a = /^(\d{2}):(\d{2})$/.exec(t1.value), b = /^(\d{2}):(\d{2})$/.exec(t2.value);
      if (dm && a) { f.start = new Date(+dm[1], +dm[2] - 1, +dm[3], +a[1], +a[2]).getTime(); f.end = b ? new Date(+dm[1], +dm[2] - 1, +dm[3], +b[1], +b[2]).getTime() : 0; }
    };
    const save = async () => {
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.value), a = /^(\d{2}):(\d{2})$/.exec(t1.value), b = /^(\d{2}):(\d{2})$/.exec(t2.value);
      if (!dm || !a) { say("Pick a date and a start time."); return; }
      const start = new Date(+dm[1], +dm[2] - 1, +dm[3], +a[1], +a[2]).getTime();
      const end = b ? new Date(+dm[1], +dm[2] - 1, +dm[3], +b[1], +b[2]).getTime() : 0;
      const r = await api.saveAppointment({ id: f.id, who: who.value, notes: notes.value, contact: contact.value, location: loc.value, shareMerav: ck.checked, start, end });
      if (r && r.ok) { apptForm = null; cursor = start; await load(true); render(); say("Saved to your calendar."); } else say((r && r.reason) || "Could not save.");
    };
    acts.append(btn("Save to calendar", "daily-btn pri", save), btn("Cancel", "daily-btn", () => { apptForm = null; render(); }));
    if (f.id) acts.append(btn("Delete", "daily-btn", async () => { if (!confirm("Delete this appointment?")) return; const r = await api.deleteAppointment(f.id); if (r && r.ok) { apptForm = null; await load(true); render(); } else say((r && r.reason) || "Could not delete."); }));
    const rb = recBtn("schedule", "daily-btn"); rb.addEventListener("click", snap, true);
    acts.append(el("span", "daily-sp"), rb);
    box.append(acts, el("div", "daily-leg", "Voice example: \"meeting on the 14th with Yossi at three\" fills the form; you check and save."));
    setTimeout(() => who.focus(), 0);
    return box;
  }

  // ---------------------------------------------------------------- Settings
  function renderSettings() {
    const st = payload.settings, p = payload.provider;
    const wrap = el("div", "daily-plain");
    const cal = card("Calendar");
    const r1 = el("div", "daily-set");
    const t1 = el("div");
    t1.append(el("b", null, "Google Calendar"), el("div", "daily-muted sm", `${p.connected ? "two-way sync" : "not connected yet - demo data is shown"}`));
    const sync = btn("Sync now", "daily-btn sm", () => { say(p.connected ? "Syncing..." : "Not connected yet - there is nothing to sync."); });
    r1.append(t1, sync);
    const r2 = el("div", "daily-set");
    const t2 = el("div");
    t2.append(el("b", null, "Share my calendar with Merav"), el("div", "daily-muted sm", "She can view and add or edit entries (for example the dentist). You do not see hers."));
    const seg = el("div", "daily-seg");
    for (const [label, val] of [["On", true], ["Off", false]]) {
      const b = btn(label, st.shareCalendarWithMerav === val ? "daily-btn on" : "daily-btn", async () => {
        const r = await api.setSettings({ shareCalendarWithMerav: val });
        if (r && r.ok) { payload.settings = r.settings; render(); } else say((r && r.reason) || "Could not save the setting.");
      });
      seg.append(b);
    }
    r2.append(t2, seg);
    cal.append(r1, r2);
    const acc = card(`Email accounts (${p.accounts.length})`);
    const r3 = el("div", "daily-set");
    const t3 = el("div");
    t3.append(el("div", null, p.accounts.join(" · ")), el("div", "daily-muted sm", "spam and promotions are hidden from My Daily · need another account? Ask the assistant; Security adds it"));
    r3.append(t3, btn("Manage accounts", "daily-btn sm", () => say("Accounts are added by the Security agent once email is connected.")));
    acc.append(r3);
    wrap.append(cal, acc);
    if (!p.connected) wrap.append(demoBanner());
    return wrap;
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!isOpen()) return;
    dateEl.textContent = payload ? (() => { const d = new Date(payload.now); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; })() : "";
    settingsBtn.classList.toggle("on", showSettings);
    closePop();
    layout = computeLayout();
    view.classList.toggle("narrow", layout === "narrow");
    view.classList.toggle("more", layout === "more");
    if (voice && (showSettings || voice.kind !== tab)) cancelVoice();   // a recording never outlives its tab
    body.replaceChildren();
    if (!payload) { renderTabs(); body.append(el("div", "daily-muted daily-pad", "Loading...")); return; }
    renderTabs();
    paintBadge();
    if (payload.notices && payload.notices.length) body.append(noticeBanner(payload.notices));
    try {
      if (showSettings) body.append(renderSettings());
      else if (tab === "today") body.append(renderToday());
      else if (tab === "shopping") body.append(renderShopping());
      else if (tab === "emails") body.append(renderEmails());
      else if (tab === "schedule") body.append(renderSchedule());
      else if (tab === "tasks") body.append(renderTasks());
      else if (tab === "dates") body.append(renderDates());
    } catch (e) {
      console.error("daily render", e);
      body.append(el("div", "daily-error", "My Daily hit a problem drawing this tab."));
    }
  }

  // ---------------------------------------------------------------- hover digest
  const digest = el("div", "daily-digest hidden");
  document.body.appendChild(digest);
  let hoverT = null, hideT = null;
  function hideDigest(now) {
    clearTimeout(hoverT);
    clearTimeout(hideT);
    if (now) digest.classList.add("hidden");
    else hideT = setTimeout(() => digest.classList.add("hidden"), 180);
  }
  async function showDigest() {
    const p = await load(false);
    if (!p || p.error || !nav.matches(":hover")) return;
    paintBadge();
    digest.replaceChildren();
    const h = el("h4");
    h.append(el("b", null, "My Daily now"), el("span", "daily-muted", ` · updated ${agoText(p.generatedAt)}`));
    digest.append(h);
    if (!p.digest.length) digest.append(el("div", "daily-muted daily-dg-empty", "Nothing needs you right now."));
    for (const l of p.digest) {
      const row = el("button", "daily-dg-row");
      row.type = "button";
      const lead = l.kind === "event" ? el("b", "daily-dg-time", l.time)
        : l.kind === "date" ? (() => { const b = el("b", "daily-dg-date"); b.append(el("span", null, String(l.day)), el("span", null, l.mon)); return b; })()
        : el("span", "daily-dg-n " + l.kind, String(l.n));
      const txt = el("span", "daily-dg-txt");
      txt.append(el("span", null, l.text), el("small", "daily-muted", l.sub));
      row.append(lead, txt);
      row.addEventListener("click", () => { hideDigest(true); openView(l.tab); });
      digest.append(row);
    }
    digest.append(el("div", "daily-dg-foot", `Click any line to jump to it. Click the row itself to open My Daily. The badge (${p.badge.count}) = open tasks; it turns blue when something needs you.`));
    const r = nav.getBoundingClientRect();
    digest.style.left = Math.round(r.right + 8) + "px";
    digest.style.top = Math.max(8, Math.min(Math.round(r.top), window.innerHeight - 380)) + "px";
    digest.classList.remove("hidden");
  }
  nav.addEventListener("mouseenter", () => { clearTimeout(hideT); clearTimeout(hoverT); hoverT = setTimeout(showDigest, 250); });
  nav.addEventListener("mouseleave", () => hideDigest(false));
  digest.addEventListener("mouseenter", () => clearTimeout(hideT));
  digest.addEventListener("mouseleave", () => hideDigest(false));

  // One-shot read to draw the badge (not a timer loop). Also exposed for the sandbox tests.
  setTimeout(() => load(false).then(paintBadge), 2500);
  window.myDaily = { open: openView, close: closeView, reload: () => load(true).then(render), state: () => ({ tab, showSettings, open: isOpen() }) };
})();

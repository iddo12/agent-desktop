// My Daily (v1.72.0) - one place for tasks, schedule, shopping lists, emails and dates. Loaded after argus.js
// (so the sidebar order is ARGUS, My Daily, IRIS). Self-contained and wrapped so a fault here can only break
// this view. LIGHT: no timers and no polling - data is loaded when the view opens or the sidebar entry is
// hovered (cached 60 s in the main process), plus ONE read shortly after start to draw the badge.
// textContent only: titles and names come from files, mail and the web and are never parsed as HTML.
(function () {
  "use strict";
  if (!window.api || !window.api.daily) return;
  const api = window.api.daily;

  const TABS = [
    ["today", "Today"], ["emails", "Emails"], ["schedule", "Schedule"], ["tasks", "Tasks"],
    ["shopping", "Shopping lists"], ["dates", "Birthdays & dates"],
  ];
  const PRI_COLORS = ["#f3f0e8", "#f0e6c0", "#ecdc9f", "#e8d085", "#e6bf6b", "#e5a95a", "#e48d4c", "#e2703f", "#dc4f35", "#c93a2a"];
  const STATUS_LABEL = { needs: "▲ Needs you", working: "▶ Working", waiting: "⏸ Waiting", queued: "… Queued" };
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
    view.classList.remove("hidden");
    nav.classList.add("active");
    if (document.body.classList.contains("argus-open")) document.querySelector("#argus-view .argus-close")?.click();
    if (document.body.classList.contains("iris-open")) document.querySelector("#iris-view .iris-close")?.click();
    const lib = document.getElementById("library-view");
    if (lib && !lib.classList.contains("hidden")) document.querySelector("#library-view .library-close")?.click();
    render();
    load(false).then(render);
  }
  function closeView() {
    document.body.classList.remove("daily-open");
    view.classList.add("hidden");
    nav.classList.remove("active");
  }
  // Any other sidebar destination closes this view first (capture, so it runs before their handlers).
  document.addEventListener("click", (e) => {
    if (!isOpen()) return;
    if (e.target.closest(".argus-nav, .iris-nav, #library-nav, #agent-list .agent-item")) closeView();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen() && !e.target.closest("#daily-view input, #daily-view textarea")) closeView();
  });

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
  function demoBanner() {
    return el("div", "daily-banner", `${payload.provider.label}. Email and calendar are not connected yet, so these are examples.`);
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
  function renderTabs() {
    tabsEl.replaceChildren();
    const counts = tabCounts();
    for (const [id, label] of TABS) {
      const b = el("button", "daily-tab" + (!showSettings && tab === id ? " on" : ""));
      b.type = "button";
      b.append(el("span", null, label));
      const c = counts[id];
      if (c && c[0]) b.append(num(c[0], c[1], c[2]));
      b.addEventListener("click", () => { tab = id; showSettings = false; render(); });
      tabsEl.append(b);
    }
  }

  // ---------------------------------------------------------------- Today
  function renderToday() {
    const s = payload.summary, d = payload.data, now = payload.now;
    const wrap = el("div", "daily-today");

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
    for (const m of d.emails.top) {
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
    if (!payload.provider.connected) wrap.append(demoBanner());
    return wrap;
  }

  // ---------------------------------------------------------------- Shopping (Phase 1: empty state + plain lists)
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
    const wrap = el("div", "daily-plain");
    const c = card("Shopping lists", [el("span", "daily-sp"), btn("+ New list", "daily-btn sm", create)]);
    if (newListOpen) c.append(form());
    for (const l of lists) {
      const n = (l.items || []).filter((i) => !i.doneAt && !i.archivedAt).length;
      const row = el("div", "daily-tk");
      row.append(el("div", "daily-ti", l.name), el("span", "daily-muted", `${n} item${n === 1 ? "" : "s"}`));
      c.append(row);
    }
    wrap.append(c, el("div", "daily-banner info", "Items, archive, add-from-link and sharing arrive in the next build."));
    return wrap;
  }

  function renderSoon(title, text) {
    const w = el("div", "daily-plain");
    const c = card(title);
    c.append(el("div", "daily-muted daily-pad", text));
    w.append(c);
    return w;
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
    t2.append(el("b", null, "Share my calendar with Merav"), el("div", "daily-muted sm", "She can view and add or edit entries (for example the dentist). Iddo does not see hers."));
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
    body.replaceChildren();
    if (!payload) { renderTabs(); body.append(el("div", "daily-muted daily-pad", "Loading...")); return; }
    renderTabs();
    paintBadge();
    try {
      if (showSettings) body.append(renderSettings());
      else if (tab === "today") body.append(renderToday());
      else if (tab === "shopping") body.append(renderShopping());
      else if (tab === "emails") body.append(renderSoon("Emails", "Needs-your-answer, sent-no-reply and people-to-write-to arrive in a later build."));
      else if (tab === "schedule") body.append(renderSoon("Schedule", "Month and six-month calendars and the Add appointment form arrive in a later build."));
      else if (tab === "tasks") body.append(renderSoon("Tasks", "The full task list with filters arrives in the next build. The top tasks are on Today."));
      else if (tab === "dates") body.append(renderSoon("Birthdays & dates", "Arrives in the next build."));
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

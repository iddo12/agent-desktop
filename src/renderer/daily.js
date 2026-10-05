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
  const STATUS_LABEL = { needs: "▲ Needs you", working: "▶ Working", waiting: "◐ Waiting", queued: "… Queued" };
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
    closePop();
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
  document.addEventListener("click", (e) => { if (pop && !e.target.closest(".daily-pop, .daily-popper")) closePop(); }, true);

  async function after(r, okMsg) {
    if (r && r.ok) { await load(true); render(); if (okMsg) say(okMsg); return true; }
    say((r && r.reason) || "That did not work.");
    return false;
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
    if (!all.length) { wrap.append(emptyState("No open tasks", "Tasks that agents file for you or work on show up here.")); return wrap; }

    // row 1: area + status + Record
    const r1 = el("div", "daily-frow");
    const seg = el("div", "daily-seg");
    for (const [v, label] of [["all", "All"], ["Business", "Business"], ["Personal", "Personal"]]) {
      seg.append(btn(label, "daily-btn" + (tf.area === v ? " on" : ""), () => { tf.area = v; tf.list = ""; render(); }));
    }
    const stBtn = btn(`Status: ${tf.status === "all" ? "All" : STATUS_PLAIN[tf.status]} ▾`, "daily-btn pill daily-popper", () => {
      openPop(stBtn, (p) => {
        for (const [v, label] of STATUS_FILTERS) p.append(btn(label, "daily-pop-item" + (tf.status === v ? " on" : ""), () => { tf.status = v; closePop(); render(); }));
      });
    });
    const rec = btn("Record ●", "daily-btn pri", () => say("Voice recording for tasks arrives in a later build."));
    r1.append(seg, stBtn, el("span", "daily-sp"), rec);
    wrap.append(r1);

    // row 2: lists (counts follow the area and status filters)
    const lc = taskListCounts(all);
    const r2 = el("div", "daily-frow");
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

    // the list
    const rows = filterTasks(all).slice().sort((a, b) => b.priority - a.priority || b.ageDays - a.ageDays);
    const c = card("Open tasks", [el("span", "daily-sp"), el("span", "daily-muted daily-sort", "sorted by priority, 10 first")]);
    if (!rows.length) c.append(el("div", "daily-muted daily-pad", "No tasks match these filters."));
    for (const t of rows) {
      const row = el("div", "daily-tk");
      const ti = el("div", "daily-ti");
      const meta = el("small", "daily-muted");
      meta.append(document.createTextNode(`${t.ageDays}d · ${t.agent} · `), el("span", "daily-scope " + (t.area === "Personal" ? "per" : "biz"), t.area));
      if (t.list) meta.append(document.createTextNode(" · "), el("span", "daily-cat", t.list));
      ti.append(el("div", null, t.title), meta);
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
    wrap.append(c);
    const lg = el("section", "daily-card daily-legendcard");
    const l1 = legendPriority();
    l1.style.marginTop = "0";
    lg.append(l1);
    wrap.append(lg);
    return wrap;
  }
  function taskListCounts(tasks) {
    const base = tasks.filter((t) => (tf.area === "all" || t.area === tf.area) && (tf.status === "all" || t.status === tf.status));
    const m = new Map();
    for (const t of base) { const k = t.list || "(no list)"; m.set(k, (m.get(k) || 0) + 1); }
    return { total: base.length, lists: Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
  }

  // ---------------------------------------------------------------- Shopping lists
  const thumbCache = new Map();   // file name -> data URL
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
    const add = async () => { const v = inp.value.trim(); if (!v) return; await after(await api.shopping({ op: "add", listId: cur.id, text: v, addedBy: "Iddo" })); const i2 = body.querySelector(".daily-shop-r input"); if (i2) i2.focus(); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    addRow.append(inp, btn("Add", "daily-btn pri", add), btn("Record ●", "daily-btn", () => say("Voice recording for shopping arrives in a later build.")));
    const linkRow = el("div", "daily-addrow");
    const link = el("input", "daily-input grow");
    link.placeholder = "or paste a product link (Amazon, B&H, AliExpress, eBay)";
    const addLink = async () => {
      const v = link.value.trim();
      if (!v) return;
      lb.disabled = true; lb.textContent = "Reading the page...";
      const r = await api.shopping({ op: "add-link", listId: cur.id, url: v, addedBy: "Iddo" });
      lb.disabled = false; lb.textContent = "Add from link";
      if (r && r.ok) { await after(r, r.detailsMissing ? "Added with the link only - details not found on that page." : "Added from the link."); }
      else say((r && r.reason) || "Could not add that link.");
    };
    const lb = btn("Add from link", "daily-btn pri", addLink);
    link.addEventListener("keydown", (e) => { if (e.key === "Enter") addLink(); });
    linkRow.append(link, lb);
    right.append(addRow, linkRow);

    const need = open.filter((i) => i.thumb && !thumbCache.has(i.thumb)).map((i) => i.thumb).concat(items.filter((i) => i.archivedAt && i.thumb && !thumbCache.has(i.thumb)).map((i) => i.thumb));
    if (need.length) api.thumbs(need).then((m) => { let any = false; for (const k of Object.keys(m || {})) { thumbCache.set(k, m[k]); any = true; } if (any && isOpen() && tab === "shopping") render(); }).catch(() => {});

    if (!open.length) right.append(el("div", "daily-muted daily-pad", "This list is empty. Add something above."));
    for (const it of open) {
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
    right.append(el("div", "daily-hint", "Tick items off in the shop. A ticked item stays for 1 hour (so a mis-tap is easy to undo), then moves to this list's Archive."));

    // archive
    const arch = items.filter((i) => i.archivedAt).sort((a, b) => Date.parse(b.doneAt || b.archivedAt) - Date.parse(a.doneAt || a.archivedAt));
    if (arch.length) {
      const ac = el("section", "daily-card daily-archive");
      const ah = el("h3", "daily-card-h");
      ah.append(el("span", null, `Archive of ${cur.name}`), el("span", "daily-n", String(arch.length)), el("span", "daily-sp"), el("span", "daily-muted daily-sort", "kept 90 days"));
      ac.append(ah);
      for (const it of arch) {
        const row = el("div", "daily-item");
        const tx = el("div", "daily-ti");
        tx.append(el("div", "daily-strike", it.text), el("small", "daily-muted", doneText(it.doneAt || it.archivedAt, now)));
        row.append(tx, btn("Bring back", "daily-btn sm", async () => { await after(await api.shopping({ op: "bring-back", listId: cur.id, itemId: it.id }), "Back on the list."); }));
        ac.append(row);
      }
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
    const lg = el("div", "daily-legendcard daily-card daily-datesleg");
    lg.append(el("b", null, "Schedule"));
    for (const [cls, label] of [["iddo", "Iddo"], ["merav", "Added by Merav"], ["bday", "Birthday / date"], ["goog", "Google Calendar"]]) {
      const s = el("span", "daily-leg-item");
      s.append(el("span", "daily-sw2 " + cls), document.createTextNode(label));
      lg.append(s);
    }
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
    closePop();
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

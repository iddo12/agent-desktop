// My Daily - Shipments tab (v1.76.0). Loaded before daily.js, which calls window.dailyShipments.create(ctx) once.
// textContent only (carrier names, events and mail text are never parsed as HTML). No timers: data loads when the tab opens
// or on "Refresh now"; the 3-hourly poll lives in the main process. Event text gets dir="auto" so Hebrew reads right-to-left.
(function () {
  "use strict";
  window.dailyShipments = {
    create(ctx) {
      const { el, btn, say, copyText, api } = ctx;
      let data = null;            // last daily-shipments-load result
      let loading = null;
      let showArchive = false;
      let showAdd = false;
      let showKey = false;
      let busy = false;
      let loadedAt = 0;
      const STALE_MS = 60000;

      const CHIP = {   // state -> [label, css class]
        action_pay: ["Pay now", "bad"], action_pickup: ["Pick up", "warn"], exception_stuck: ["Problem", "bad"],
        out_for_delivery: ["Out for delivery", "ok"], in_transit: ["In transit", ""], customs: ["In customs", ""],
        shipped: ["Shipped", ""], ordered: ["Ordered", "mute"], delivered: ["Delivered", "ok"],
      };
      const CARRIER_ICON = { fedex: "FX", ups: "UPS", dhl: "DHL", dhl_ecom: "DHL", amazon: "AMZ", cainiao: "CNO", israelpost: "IL", yunexpress: "YT", aramex: "ARX", cheetah: "CH", hfd: "HFD", gaash: "GA", orian: "OR", exelot: "EX", other: "?" };
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

      function load(force) {
        if (loading) return loading;
        loading = (force ? api.shipmentsRefresh() : api.shipmentsLoad(false))
          .then((r) => { if (r && r.ok) { data = r; loadedAt = Date.now(); } else if (r && r.reason) say(r.reason); return r; })
          .catch((e) => { console.error("shipments load", e); return null; })
          .finally(() => { loading = null; });
        return loading;
      }
      const ago = (ms, now) => {
        if (!ms) return "";
        const m = Math.max(0, Math.round(((now || Date.now()) - ms) / 60000));
        return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
      };
      const dayText = (iso, now) => {
        const t = Date.parse(iso || "");
        if (!Number.isFinite(t)) return "";
        const a = new Date(now); a.setHours(0, 0, 0, 0);
        const b = new Date(t); b.setHours(0, 0, 0, 0);
        const d = Math.round((b - a) / 86400000);
        const base = `${b.getDate()} ${MONTHS[b.getMonth()]}`;
        return d === 0 ? "today" : d === 1 ? "tomorrow" : d === -1 ? "yesterday" : base;
      };
      const chipEl = (state) => { const c = CHIP[state] || ["?", ""]; return el("span", "ship-chip " + c[1], c[0]); };

      async function act(op, id, extra, okMsg) {
        if (busy) return;
        busy = true;
        const r = await api.shipmentsOp(Object.assign({ op, id }, extra || {}));
        busy = false;
        if (r && r.ok) { await load(false); ctx.rerender(); if (okMsg) say(okMsg); }
        else say((r && r.reason) || "That did not work.");
        return r;
      }

      function row(s, now, archived) {
        const r = el("div", "ship-row" + (archived ? " archived" : ""));
        const ico = el("div", "ship-ico", CARRIER_ICON[s.carrier] || "?");
        ico.title = s.carrierName;
        const main = el("div", "ship-main");
        const l1 = el("div", "ship-l1");
        const name = s.title || s.merchant || (s.numbers[0] ? s.carrierName : "Parcel");
        l1.append(el("b", "ship-name", name), chipEl(s.effective));
        if (s.merchant && s.title && s.merchant !== s.title) l1.append(el("span", "ship-merch", s.merchant));
        const l2 = el("div", "ship-l2");
        l2.append(el("span", "ship-carrier", s.carrierName));
        for (const n of s.numbers.slice(0, 3)) {
          const nb = btn(n.no, "ship-no", () => { copyText(n.no); say("Tracking number copied."); });
          nb.title = `${n.carrierName} - click to copy`;
          l2.append(nb);
        }
        if (s.eta && !archived) l2.append(el("span", "ship-eta", "ETA " + dayText(s.eta, now)));
        main.append(l1, l2);
        if (s.action && !archived) main.append(el("div", "ship-action " + (CHIP[s.effective] || [0, ""])[1], "! " + s.action));
        const ev = s.lastEvent;
        if (ev && ev.text) {
          const l3 = el("div", "ship-ev");
          const t = el("span", "ship-ev-t", ev.text);
          t.setAttribute("dir", "auto");
          l3.append(t);
          const tail = [ev.place, ev.at ? ago(ev.at, now) : ""].filter(Boolean).join(" - ");
          if (tail) { const p = el("span", "ship-ev-p", " (" + tail + ")"); p.setAttribute("dir", "auto"); l3.append(p); }
          main.append(l3);
        } else if (!archived) main.append(el("div", "ship-ev ship-muted", s.source === "email" ? "No live tracking yet - state comes from the email." : "Waiting for the first tracking event."));
        if (s.note2) main.append(el("div", "ship-ev ship-muted", s.note2));
        if (s.from && s.title !== "From " + s.from) main.append(el("div", "ship-from ship-muted", "From " + s.from + (s.to ? " to " + s.to : "")));
        const acts = el("div", "ship-acts");
        if (s.url) { const o = btn("Carrier page", "daily-btn sm", () => window.open(s.url)); o.title = "Open the carrier's own tracking page in your browser"; acts.append(o); }
        if (!archived) {
          if (s.effective === "action_pickup" || s.effective === "out_for_delivery") acts.append(btn("Mark picked up", "daily-btn sm pri", () => act("picked-up", s.id, null, "Marked as picked up and archived.")));
          else acts.append(btn("Picked up", "daily-btn sm", () => act("picked-up", s.id, null, "Marked as picked up and archived.")));
          acts.append(btn("Archive", "daily-btn sm", () => act("archive", s.id, null, "Archived.")));
        } else {
          acts.append(btn("Bring back", "daily-btn sm", () => act("unarchive", s.id, null, "Back in the active list.")));
          acts.append(btn("Delete", "daily-btn sm", () => act("delete", s.id, null, "Deleted.")));
        }
        r.append(ico, main, acts);
        return r;
      }

      function group(title, list, now, cls, note) {
        const g = el("section", "daily-card ship-group " + (cls || ""));
        const h = el("h3", "daily-card-h");
        h.append(el("span", null, title), el("span", "daily-n " + (cls === "needs" ? "warn" : ""), String(list.length)));
        if (note) h.append(el("span", "daily-muted ship-note", note));
        g.append(h);
        for (const s of list) g.append(row(s, now, false));
        return g;
      }

      function addBar() {
        const w = el("div", "ship-add");
        const inp = el("input", "daily-input grow");
        inp.placeholder = "Paste a tracking number, a tracking link or an SMS - or dictate it";
        inp.maxLength = 400;
        inp.setAttribute("dir", "auto");
        const go = async () => {
          const v = inp.value.trim();
          if (!v) return;
          const r = await act("add", null, { text: v }, "Added.");
          if (r && r.ok) { showAdd = false; ctx.rerender(); }
        };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") { showAdd = false; ctx.rerender(); } });
        w.append(inp, btn("Add", "daily-btn pri", go), btn("Cancel", "daily-btn", () => { showAdd = false; ctx.rerender(); }));
        setTimeout(() => inp.focus(), 0);
        return w;
      }

      // Password field -> IPC -> safeStorage in the main process. The key is never shown again, only "key stored".
      function keyBox() {
        const p = data.provider;
        const box = el("div", "daily-card ship-key");
        box.append(el("b", null, "Live tracking key (17TRACK)"));
        box.append(el("div", "daily-muted sm", p.has17 ? "A key is stored on this PC (encrypted by Windows). Parcels are refreshed every 3 hours." : "Free account at 17track.net (200 free parcels). Paste the key once; it is stored encrypted on this PC and never leaves the main process."));
        const row2 = el("div", "ship-add");
        const inp = el("input", "daily-input grow");
        inp.type = "password"; inp.autocomplete = "off"; inp.spellcheck = false; inp.maxLength = 200;
        inp.placeholder = p.has17 ? "Paste a new key to replace the stored one" : "Paste the 17TRACK key";
        const save = async () => {
          const v = inp.value;
          if (!v.trim()) return;
          const r = await api.shipmentsSetKey("17track", v);
          inp.value = "";
          if (r && r.ok) { say("Key saved. Refreshing..."); showKey = false; await load(true); ctx.rerender(); }
          else say((r && r.reason) || "Could not save the key.");
        };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
        row2.append(inp, btn("Save key", "daily-btn pri", save));
        if (p.has17) row2.append(btn("Remove key", "daily-btn", async () => { await api.shipmentsClearKey("17track"); await load(false); ctx.rerender(); say("Key removed."); }));
        if (!p.canEncrypt) box.append(el("div", "daily-banner", "This PC cannot encrypt the key, so it cannot be stored here."));
        box.append(row2);
        const dh = el("div", "ship-add");
        const inp2 = el("input", "daily-input grow");
        inp2.type = "password"; inp2.autocomplete = "off"; inp2.spellcheck = false; inp2.maxLength = 200;
        inp2.placeholder = p.hasDhl ? "DHL key stored - paste to replace (optional)" : "DHL key (optional, free at developer.dhl.com)";
        const save2 = async () => {
          const v = inp2.value; if (!v.trim()) return;
          const r = await api.shipmentsSetKey("dhl", v); inp2.value = "";
          if (r && r.ok) { say("DHL key saved."); await load(false); ctx.rerender(); } else say((r && r.reason) || "Could not save the key.");
        };
        inp2.addEventListener("keydown", (e) => { if (e.key === "Enter") save2(); });
        dh.append(inp2, btn("Save", "daily-btn", save2));
        if (p.hasDhl) dh.append(btn("Remove", "daily-btn", async () => { await api.shipmentsClearKey("dhl"); await load(false); ctx.rerender(); }));
        box.append(dh);
        return box;
      }

      function render() {
        const wrap = el("div", "daily-plain ship-wrap");
        if (!data || Date.now() - loadedAt > STALE_MS) {
          if (!loading) load(false).then(() => { if (ctx.isActive()) ctx.rerender(); });
          if (!data) { wrap.append(el("div", "daily-muted daily-pad", "Loading shipments...")); return wrap; }
        }
        const now = data.now;
        const p = data.provider;
        const bar = el("div", "ship-bar");
        bar.append(btn("+ Add shipment", "daily-btn pri", () => { showAdd = !showAdd; ctx.rerender(); }));
        const rb = btn(loading ? "Refreshing..." : "Refresh now", "daily-btn", async () => {
          rb.disabled = true;
          const r = await load(true);
          ctx.rerender();
          if (r && r.ok && r.refresh) say(r.refresh.polled ? `Checked ${r.refresh.polled} tracking number${r.refresh.polled === 1 ? "" : "s"}${r.refresh.errors ? `, ${r.refresh.errors} could not be read${r.refresh.firstError ? " (" + r.refresh.firstError + ")" : ""}` : ""}.` : "Mail scanned. No live tracking key, so there was nothing to poll.");
        });
        bar.append(rb, btn(showKey ? "Hide key settings" : "Tracking key", "daily-btn" + (showKey ? " on" : ""), () => { showKey = !showKey; ctx.rerender(); }));
        bar.append(el("span", "daily-sp"));
        const stamp = [];
        if (p.scannedAt) stamp.push("mail scanned " + ago(p.scannedAt, now));
        if (p.live && p.polledAt) stamp.push("tracking checked " + ago(p.polledAt, now));
        if (stamp.length) bar.append(el("span", "daily-muted ship-note", stamp.join(" - ")));
        wrap.append(bar);
        if (!p.live) {
          const b = el("div", "daily-banner info ship-banner");
          b.append(el("b", null, "Add a tracking key to get live status. "), document.createTextNode("Without it, parcels found in your email show the state the email reported, and nothing updates on its own. "));
          b.append(btn("Add key", "daily-btn sm", () => { showKey = true; ctx.rerender(); }));
          wrap.append(b);
        }
        if (p.lastError) wrap.append(el("div", "daily-banner", "Last mail scan problem: " + p.lastError));
        if (showKey) wrap.append(keyBox());
        if (showAdd) wrap.append(addBar());

        const active = data.items.filter((s) => !s.archived);
        const needs = active.filter((s) => ["action_pay", "action_pickup", "exception_stuck"].includes(s.effective));
        const transit = active.filter((s) => !needs.includes(s));
        const arch = data.items.filter((s) => s.archived).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
        needs.sort((a, b) => (a.pickupBy ? Date.parse(a.pickupBy) : Infinity) - (b.pickupBy ? Date.parse(b.pickupBy) : Infinity) || (b.updated || 0) - (a.updated || 0));
        transit.sort((a, b) => (a.eta ? Date.parse(a.eta) : Infinity) - (b.eta ? Date.parse(b.eta) : Infinity) || (b.updated || 0) - (a.updated || 0));

        // legend: what the chips mean (colours always explained)
        const lg = el("div", "daily-legend ship-legend");
        lg.append(el("span", "daily-muted", "Legend"), el("span", "ship-chip bad", "Pay / problem"), el("span", "ship-chip warn", "Pick up"), el("span", "ship-chip ok", "Out / delivered"), el("span", "ship-chip", "On its way"));
        wrap.append(lg);

        if (!data.items.length) {
          wrap.append(ctx.emptyState("No parcels yet", "Parcels from your email appear here by themselves. You can also add one by hand.", "+ Add shipment", () => { showAdd = true; ctx.rerender(); }));
          return wrap;
        }
        if (needs.length) wrap.append(group("Needs action", needs, now, "needs", "pay, pick up or stuck"));
        if (transit.length) wrap.append(group("On the way", transit, now, "transit"));
        if (!needs.length && !transit.length) wrap.append(el("div", "daily-muted daily-pad", "Nothing is on the way right now."));
        const ag = el("section", "daily-card ship-group archive");
        const ah = el("h3", "daily-card-h");
        const tgl = btn((showArchive ? "▾ " : "▸ ") + "Delivered and archived", "ship-toggle", () => { showArchive = !showArchive; ctx.rerender(); });
        ah.append(tgl, el("span", "daily-n", String(arch.length)));
        ag.append(ah);
        if (showArchive) { if (!arch.length) ag.append(el("div", "daily-muted daily-pad", "Nothing archived yet.")); for (const s of arch.slice(0, 100)) ag.append(row(s, now, true)); }
        wrap.append(ag);
        wrap.append(el("div", "daily-muted sm ship-foot", "Tracking data is read from your email (read-only) and, with a key, from 17TRACK. Only the tracking number is sent to the tracking service."));
        return wrap;
      }

      return {
        render,
        // [needs-action count, colour, tooltip] for the tab, once loaded
        tabCount() { return data && data.counts && data.counts.needs ? [data.counts.needs, "warn", `${data.counts.needs} parcel${data.counts.needs === 1 ? "" : "s"} need action`] : null; },
        invalidate() { loadedAt = 0; },
      };
    },
  };
})();

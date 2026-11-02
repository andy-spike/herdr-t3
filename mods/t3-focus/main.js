// The focus sidebar: no spaces, only the agents still asking for attention, as cards, latest news first.
// Below, as in T3: Working (busy agents, folded) and Settled (put away by hand until new work brings them back).
// Settled lives on the agent's own terminal as `settled=<ms>:<turn>`: it ends with the terminal, every mod
// sees it, and a turn ended since says there was new work even while no window watched. Looking doesn't count.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, InputState, Input } from "gpui-base";
import { agents, terminals, panes, spaces, focused, run, hc, notify, theme, shared, setShared, setAgentOrder, props, openOverlay, closeOverlay, nextCommand, keys } from "herdr";
import { namer } from "./name.js";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const BUSY = new Set(["working", "blocked"]);
// Space avatar colors, as the Herdr T3 layout's t3-spaces draws them (shared "space.colors").
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// The settled tail opens on this many, then grows by MORE.
const FIRST = 10, MORE = 25;

// A sub-agent's own word: error counts as blocked; its done is its parent's news, not its own.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 10080) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 10080)}w`;
}

// How long it's been working: seconds, then as ago() counts.
function took(ms, now) {
  const s = Math.floor((now - ms) / 1000);
  return s < 60 ? `${s}s` : ago(ms, now);
}

const DAY = 86400000;
// What the sidebar keeps on an agent's terminal, as labels every mod (and the menu popup) can read:
// settled=<ms>:<turn>; snoozed=<wake ms>:<turn>; t3.keep=<turn> (un-settled by hand: no auto-settle until a
// newer turn, as T3's override); t3.autosettle=off (this agent never auto-settles).
const KEYS = ["settled", "snoozed", "t3.keep", "t3.autosettle"];
const pair = (v) => (v ? v.split(":").map(Number) : null);
const labelNow = (addr, k) => terminals().find((x) => x.address === addr)?.labels?.[k];

function writeLabels(addr, kv) {
  return hc(["label", addr, ...Object.entries(kv).map(([k, v]) => `${k}=${v ?? ""}`)])
    .catch((e) => ({ code: 1, stderr: String(e) }))
    .then((r) => {
      if (r.code !== 0) notify({ title: "Couldn't update the agent", body: (r.stderr ?? "").trim(), level: "error" });
      return r.code === 0;
    });
}

// T3's undo: the latest settle, snooze or unpin can be taken back for 5 seconds. Shared, so the menu
// popup's actions show in the sidebar too. `before` is each agent's labels and the pins as they were.
const UNDO_MS = 5000;
function snapshot(addrs, read) {
  return { pins: shared("agents.pins") ?? [], items: Object.fromEntries(addrs.map((a) => [a, Object.fromEntries(KEYS.map((k) => [k, read(a, k) ?? ""]))])) };
}
function remember(text, addrs, before) {
  setShared("t3-focus.undo", { id: `${Date.now()}-${addrs.join(",")}`, text, count: addrs.length, at: Date.now(), before });
}

// T3's default snooze menu: 1 hour, 3 hours, today 6 PM, tomorrow 9 AM, Monday 9 AM; past times left out.
function clock(ms) {
  const d = new Date(ms), h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
function snoozePresets(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const at = (days, h) => { const d = new Date(nowMs); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const monday = (8 - now.getDay()) % 7 || 7;
  return [
    { label: "1 hour", until: nowMs + 3600000 },
    { label: "3 hours", until: nowMs + 3 * 3600000 },
    { label: `Today, ${clock(at(0, 18))}`, until: at(0, 18) },
    { label: `Tomorrow, ${clock(at(1, 9))}`, until: at(1, 9) },
    { label: `Monday, ${clock(at(monday, 9))}`, until: at(monday, 9) },
  ].filter((p) => p.until > nowMs);
}
// When a snoozed agent wakes: a time today, else the weekday, else the date.
function wakes(ms, nowMs) {
  const d = new Date(ms), n = new Date(nowMs);
  if (d.toDateString() === n.toDateString()) return clock(ms);
  if (ms - nowMs < 6 * DAY) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${clock(ms)}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Closes a pane; an agent still working or waiting on you asks first, since closing ends it.
function closePane(pane, name, status) {
  if (status === "working" || status === "blocked") {
    return openOverlay({ mod: "confirm", kind: "dialog", width: 400, height: 170, props: {
      title: `Close ${name}?`,
      detail: status === "working" ? "It's still working. Closing ends it and its sub-agents." : "It's waiting on you. Closing ends it.",
      command: { name: "pane.close", args: { pane } },
    } });
  }
  run("pane.close", { pane });
}

// The right-click menu's items for one agent, as T3's thread menu: pin, settle, snooze, auto-settle, rename, close.
function menuItems(addr) {
  const a = agents().find((x) => x.address === addr), term = terminals().find((k) => k.address === addr);
  if (!a || !term) return [];
  const lb = term.labels ?? {}, pins = shared("agents.pins") ?? [], turn = term.turn ?? 0;
  const pinned = pins.includes(addr), settled = Boolean(lb.settled), snoozed = Boolean(lb.snoozed);
  const busy = a.status === "working" || a.status === "blocked";
  const undoable = (text, fn) => () => { const before = snapshot([addr], labelNow); fn(); remember(text, [addr], before); };
  const unpin = () => setShared("agents.pins", (shared("agents.pins") ?? []).filter((p) => p !== addr));
  const W = "mods/workspace-chrome/";
  return [
    pinned ? { label: "Unpin", icon: `${W}pin-off.svg`, fn: undoable("Unpinned", unpin) }
      : { label: "Pin", icon: `${W}pin.svg`, fn: () => setShared("agents.pins", [...pins, addr]) },
    settled ? { label: "Un-settle", icon: "mods/t3-focus/undo.svg", fn: () => writeLabels(addr, { settled: "", "t3.keep": turn }) }
      // Busy work can't be settled: new work brings it straight back.
      : !busy && { label: "Settle", icon: `${W}circle-check.svg`, fn: undoable("Settled", () => {
        writeLabels(addr, { settled: `${Date.now()}:${turn}`, snoozed: "", "t3.keep": "" });
        if (pinned) unpin();
      }) },
    snoozed && { label: "Wake", icon: `${W}clock.svg`, fn: () => writeLabels(addr, { snoozed: "" }) },
    // Something waiting on the person can't be snoozed (T3's canSnooze); working can, and stays hidden.
    ...(!snoozed && a.status !== "blocked" ? [{ header: "Snooze until" }, ...snoozePresets().map((p) => ({
      label: p.label, icon: `${W}clock.svg`,
      fn: undoable("Snoozed", () => writeLabels(addr, { snoozed: `${p.until}:${turn}`, settled: "" })),
    }))] : []),
    { sep: true },
    lb["t3.autosettle"] === "off"
      ? { label: "Enable auto-settle", icon: `${W}circle-check.svg`, fn: () => writeLabels(addr, { "t3.autosettle": "" }) }
      : { label: "Disable auto-settle", icon: `${W}minus.svg`, fn: () => writeLabels(addr, { "t3.autosettle": "off" }) },
    a.tab && { label: "Rename…", icon: `${W}square-pen.svg`, fn: () => run("tab.rename", { id: a.tab }) },
    a.pane && { label: "Close", icon: `${W}x.svg`, fn: () => closePane(a.pane, namer()(a), a.status), danger: true },
  ].filter(Boolean);
}
const menuHeight = (items) => 8 + items.reduce((h, it) => h + (it.sep ? 9 : it.header ? 24 : 30), 0);

// The program's icon from the app's table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Focus extends View {
  init(_props, cx) {
    // The right-click menu is a popup copy of this mod; it keeps no state of its own.
    if (props()?.menu) return;
    // Each agent's last state and when we saw it change or brought it back (ms; 0: before we were watching).
    this.changed = JSON.parse(localStorage.getItem("changes") ?? "{}");
    this.open = localStorage.getItem("open") === "true";
    this.workOpen = localStorage.getItem("working-open") === "true";
    this.snoozeOpen = localStorage.getItem("snoozed-open") === "true";
    this.limit = FIRST;
    // Labels written but not back from the core yet: "address|key" → value ("" = removed).
    this.pending = {};
    // Undo's key (layout keys: "t3-focus.undo").
    cx.spawn(async (cx) => {
      for (;;) {
        if (await nextCommand() !== "undo") continue;
        this.undo(cx);
        cx.notify();
      }
    });
    // Snoozed agents wake, and idle ones auto-settle, on the clock: look again every minute.
    cx.timer.every(60000, (cx) => { if (this.clockNeeded) cx.notify(); });
    this.hovered = null;
    // The spaces shown, as T3 scopes threads to projects; none: all of them.
    this.scope = JSON.parse(localStorage.getItem("scope") ?? "[]");
    this.scopeOpen = false;
    this.search = InputState.new({ placeholder: "Search spaces…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => this.pick(this.matches()[0], false, cx));
    // Takes the keyboard while a row is lifted, so Esc can put it back.
    this.keys = cx.focus_handle();
    // "Working 9s" counts up only while such a card shows.
    cx.timer.every(1000, (cx) => { if (this.ticking) cx.notify(); });
  }

  matches() {
    const q = this.search.value().toLowerCase();
    return [{ id: null, name: "All spaces" }, ...spaces()].filter((s) => s.name.toLowerCase().includes(q));
  }

  // A click shows that space alone; shift-click adds or removes it and keeps the menu open, as in T3.
  pick(s, shift, cx) {
    if (!s) return;
    this.scope = shared("t3-focus.scope") ?? this.scope;
    this.scope = !s.id ? [] : !shift ? [s.id] : this.scope.includes(s.id) ? this.scope.filter((id) => id !== s.id) : [...this.scope, s.id];
    localStorage.setItem("scope", JSON.stringify(this.scope));
    setShared("t3-focus.scope", this.scope);
    if (!shift) this.scopeOpen = false;
    cx.notify();
  }

  // Done and idle count as one: looking at a finished agent turns done into idle, and looking isn't news.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      const was = this.changed[a.address];
      if (was?.s === s) continue;
      // First sight says nothing about when it changed.
      this.changed[a.address] = { s, at: was ? now : 0 };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const k of Object.keys(this.changed)) if (!listed.has(k)) delete this.changed[k];
    localStorage.setItem("changes", JSON.stringify(this.changed));
  }

  descendants(all, addr) {
    return all.filter((k) => k.parent === addr && k.state === "live").flatMap((k) => [k, ...this.descendants(all, k.address)]);
  }

  // Shown at once; the labels come back from the core a moment later.
  put(addr, kv, cx) {
    for (const [k, v] of Object.entries(kv)) this.pending[`${addr}|${k}`] = String(v ?? "");
    cx.spawn(async (cx) => {
      if (await writeLabels(addr, kv)) return;
      for (const k of Object.keys(kv)) delete this.pending[`${addr}|${k}`];
      cx.notify();
    });
  }

  label(addr, k) {
    return this.pending[`${addr}|${k}`] ?? labelNow(addr, k);
  }

  // A change on its way to the core: the row can't be picked up until it's back.
  waiting(addr) {
    return Object.keys(this.pending).some((k) => k.startsWith(`${addr}|`));
  }

  // Puts back what the latest settle, snooze or unpin changed, within T3's 5 seconds.
  undo(cx) {
    const u = shared("t3-focus.undo");
    if (!u || Date.now() - u.at > UNDO_MS) return;
    setShared("t3-focus.undo", null);
    setShared("agents.pins", u.before.pins);
    for (const [addr, kv] of Object.entries(u.before.items)) {
      if (KEYS.some((k) => (this.label(addr, k) ?? "") !== kv[k])) this.put(addr, kv, cx);
    }
  }

  // The right-click menu, drawn by the popup copy (props.menu = { address }). Its actions write labels and
  // pins themselves and leave an undo the sidebar shows.
  menu() {
    const t = theme(), items = menuItems(props().menu.address);
    const close = () => closeOverlay(props().overlay);
    return v_flex().id("t3-focus-menu").size_full().p(4).bg(t.popover).text_size(13)
      .when(!items.length, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("This agent is gone.")))
      .children(items.map((it, i) => it.sep ? div().id(`menu-sep-${i}`).h(1).my(4).mx(4).flex_none().bg(t.border)
        : it.header ? div().id(`menu-head-${i}`).h(24).px(8).pt(6).flex_none().text_size(11).text_color(t.dim).child(it.header)
        : h_flex().id(`menu-item-${i}`).h(30).px(8).gap(8).flex_none().items_center().rounded(6)
          .text_color(it.danger ? t.ansi1 : t.foreground).hover((s) => s.bg(t.hover))
          .role("button").accessibility_label(it.label)
          .on_click(() => { it.fn(); close(); })
          .child(svg(it.icon).size(14).flex_none().text_color(it.danger ? t.ansi1 : t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it.label))));
  }

  openMenu(addr) {
    openOverlay({ mod: "t3-focus", kind: "popup", width: 220, height: menuHeight(menuItems(addr)), props: { menu: { address: addr } } });
  }

  // Ends a drag or sweep, and hands the keyboard back to the pane that had it, unless the drop moved on to
  // another agent. Not FocusHandle.release(): that frees the handle, and the next drag would throw.
  // `this.back` is set only once something lifted.
  endDrag(restore = true) {
    const back = restore ? this.back : null;
    this.drag = this.sweep = this.back = null;
    if (back?.pane) run("pane.focus", { pane: back.pane });
    else if (back?.terminal) run("pane.focus", { terminal: back.terminal });
    return null;
  }

  render(cx) {
    if (props()?.menu) return this.menu();
    const t = theme(), now = Date.now();
    const every = agents(), all = terminals(), ps = panes(), sp = spaces();
    // A space that's gone reads as all; its id stays stored, so the scope returns with it.
    // The layout's brand bar (t3-chrome) can hold the filter: the scope is shared, this copy's own as a fallback.
    const scope = (shared("t3-focus.scope") ?? this.scope).filter((id) => sp.some((s) => s.id === id));
    const list = scope.length ? every.filter((a) => scope.includes(a.space)) : every;
    const listed = new Map(every.map((a) => [a.address, a.status]));
    const term = new Map(all.map((k) => [k.address, k]));
    for (const [key, v] of Object.entries(this.pending)) {
      const [addr, k] = key.split("|");
      if (!term.has(addr) || (term.get(addr).labels?.[k] ?? "") === v) delete this.pending[key];
    }
    const turnOf = (a) => term.get(a.address)?.turn ?? 0;
    const settledAt = (a) => pair(this.label(a.address, "settled"));
    const snoozedAt = (a) => pair(this.label(a.address, "snoozed"));
    const tree = new Map(every.map((a) => [a.address, this.descendants(all, a.address)]));
    const kids = new Map(every.map((a) => [a.address, tree.get(a.address).map((k) => kidStatus(k, listed))]));
    // It, or anything under it, is working or needs the person.
    const busy = (a) => BUSY.has(a.status) || kids.get(a.address).some((s) => BUSY.has(s));
    // The most urgent of it and what's under it.
    const state = (a) => [a.status, ...kids.get(a.address)].reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m));
    // New work brings a settled agent back: busy now, or a turn ended since it was settled. Hidden ones too.
    // A snoozed one keeps working out of sight; it wakes at its time, or early when it needs the person (T3).
    for (const a of every) {
      const s = settledAt(a), z = snoozedAt(a);
      if (s && !z && (busy(a) || turnOf(a) > s[1])) this.put(a.address, { settled: "" }, cx);
      if (z && (z[0] <= now || state(a) === "blocked")) this.put(a.address, { snoozed: "" }, cx);
    }
    // Sub-agents without a pane are tracked too, so a parent waiting on them can say how long they've worked.
    const subs = all.filter((k) => k.parent && k.state === "live" && !listed.has(k.address)).map((k) => ({ address: k.address, status: kidStatus(k, listed) }));
    this.track([...every, ...subs], now);
    // Back from Settled or Snoozed, however (a button, the menu, new work, its wake time), it's news: the top.
    const parked = new Set(every.filter((a) => settledAt(a) || snoozedAt(a)).map((a) => a.address));
    let back = false;
    for (const addr of this.parked ?? []) {
      if (parked.has(addr) || !listed.has(addr)) continue;
      this.changed[addr] = { ...this.changed[addr], at: now };
      back = true;
    }
    if (back) localStorage.setItem("changes", JSON.stringify(this.changed));
    this.parked = parked;
    // Seen changing, then; before that, the core's time of its last change. terminals() only has that as of
    // the app's start (status_ms isn't updated live), so it serves only until we see a change ourselves.
    const since = (a) => this.changed[a.address]?.at || term.get(a.address)?.status_ms || 0;
    // Working since: its own turn, else its longest-working sub-agent's.
    const started = (a) => a.status === "working" ? since(a)
      : Math.min(Infinity, ...tree.get(a.address).filter((k) => kidStatus(k, listed) === "working").map(since).filter((ms) => ms > 0));
    // T3's Working: busy, or waiting on sub-agents it will hear back from; needing the person keeps it up top.
    const working = (a) => state(a) !== "blocked" && (a.status === "working" || kids.get(a.address).includes("working"));
    // Up top by when each came back to the person; Working by when it was last set going.
    const newest = (x, y) => since(y) - since(x) || y.seq - x.seq;
    // Pins are the agents list's (t3-agents), one set for both: pinned agents stay up top in pin order, whatever their state.
    // As T3's sections: snoozed, then settled, win over pinned (a snoozed pin keeps its pin for when it wakes).
    const pins = shared("agents.pins") ?? [];
    const pinned = pins.map((p) => list.find((a) => a.address === p)).filter((a) => a && !settledAt(a) && !snoozedAt(a));
    const rest = list.filter((a) => !pinned.includes(a));
    const out = rest.filter((a) => !settledAt(a) && !snoozedAt(a) && !working(a)).sort(newest);
    const work = rest.filter((a) => !settledAt(a) && !snoozedAt(a) && working(a)).sort(newest);
    const snz = rest.filter(snoozedAt).sort((x, y) => snoozedAt(x)[0] - snoozedAt(y)[0]);
    const put = rest.filter((a) => settledAt(a) && !snoozedAt(a)).sort((x, y) => settledAt(y)[0] - settledAt(x)[0]);
    // Settled and snoozed agents aren't passed: Herdr appends them, so agent.next reaches them last.
    setAgentOrder([...pinned, ...out, ...work].map((a) => a.address));

    // T3's auto-settle: finished work idle for `autoSettleDays` (layout prop, default 3; 0: never) settles by
    // itself, pinned or not (settling unpins). Not what's busy, snoozed, in view, kept by hand, or opted out.
    const days = Number(props()?.autoSettleDays ?? 3);
    this.clockNeeded = days > 0 || snz.length > 0;
    const unpinAuto = [];
    if (days > 0) for (const a of every) {
      if (settledAt(a) || snoozedAt(a) || busy(a) || a.focused || this.waiting(a.address)) continue;
      if (this.label(a.address, "t3.autosettle") === "off") continue;
      const keep = this.label(a.address, "t3.keep");
      if (keep && Number(keep) >= turnOf(a)) continue;
      const at = since(a);
      if (!(at > 0 && now - at >= days * DAY)) continue;
      this.put(a.address, { settled: `${now}:${turnOf(a)}`, "t3.keep": "" }, cx);
      if (pins.includes(a.address)) unpinAuto.push(a.address);
    }
    if (unpinAuto.length) cx.spawn(async () => setShared("agents.pins", (shared("agents.pins") ?? []).filter((p) => !unpinAuto.includes(p))));

    const title = namer();
    const hover = (a) => (on, cx) => {
      if (on) this.hovered = a.address;
      else if (this.hovered === a.address) this.hovered = null;
      cx.notify();
    };
    // A button's icon and text brighten together: a hover style reaches the text but not the svg, so it's state.
    const glow = (id) => (on, cx) => {
      if (on) this.hot = id;
      else if (this.hot === id) this.hot = null;
      cx.notify();
    };
    const lit = (id, color) => (this.hot === id ? t.foreground : color);
    // A space's avatar, as t3-spaces draws it.
    const avatar = (id, name, size) => {
      const color = (shared("space.colors") ?? {})[id] ?? "ansi6";
      return h_flex().size(size).flex_none().rounded(4).bg(color.startsWith("#") ? color : MARK[color] ?? t[color])
        .items_center().justify_center().text_size(size * 0.64).font_bold().text_color("#ffffff")
        .child([...(name ?? "")][0]?.toUpperCase() ?? "?");
    };
    // Brought back, it's news again: the top of the list.
    // Un-settled by hand, it stays out of auto-settle until a newer turn (T3's override).
    const unsettle = (a, cx) => {
      this.put(a.address, { settled: "", "t3.keep": turnOf(a) }, cx);
      this.changed[a.address] = { ...this.changed[a.address], at: Date.now() };
      localStorage.setItem("changes", JSON.stringify(this.changed));
    };
    const wake = (a, cx) => {
      this.put(a.address, { snoozed: "" }, cx);
      this.changed[a.address] = { ...this.changed[a.address], at: Date.now() };
      localStorage.setItem("changes", JSON.stringify(this.changed));
    };
    const lab = (addr, k) => this.label(addr, k);
    // Settling removes a pin, as in T3, and can be undone for 5 seconds.
    // Settling the agent in view moves on to the next card; one in the background moves nothing.
    const settle = (xs, cx) => {
      const addrs = xs.map((a) => a.address);
      remember("Settled", addrs, snapshot(addrs, lab));
      for (const a of xs) this.put(a.address, { settled: `${Date.now()}:${turnOf(a)}`, snoozed: "", "t3.keep": "" }, cx);
      if (xs.some((a) => pins.includes(a.address))) setShared("agents.pins", pins.filter((p) => !addrs.includes(p)));
      if (!xs.some((a) => a.focused)) return false;
      const i = out.findIndex((a) => a.focused), next = [...out.slice(i + 1), ...out.slice(0, Math.max(i, 0)).reverse()].find((a) => !xs.includes(a));
      if (next) run("agent.focus", { terminal: next.address });
      return Boolean(next);
    };

    // Dragging, as T3's sidebar does it (Sidebar.drag.ts, Sidebar.pointer.ts). Press a row and move 6px to lift it;
    // it follows the pointer up and down inside the list and says what letting go will do. While it's lifted, the
    // Pinned and Active labels open, and the list opens a gap the size of the destination's row where it will
    // land. Pinned keeps a hand-made order; Active and Settled keep their own, so the gap opens where that puts it.
    let d = this.drag;
    // A row that leaves the list (its agent ended, a filter) can't be dropped. Render can't run commands, so
    // `this.back` stays and the release (or Esc, or leaving) hands the keyboard back.
    if (d && !list.some((a) => a.address === d.from)) d = this.drag = null;
    const dragging = Boolean(d?.moved);
    const lifted = dragging ? list.find((a) => a.address === d.from) : null;
    const sectionOf = (a) => snoozedAt(a) ? "snoozed" : settledAt(a) ? "settled" : pinned.includes(a) ? "pinned" : working(a) ? "working" : "active";
    const from = lifted ? sectionOf(lifted) : null;
    const others = (xs) => xs.filter((x) => x.address !== d?.from);
    const pinTo = (before) => ({ section: "pinned", before: before ?? null });
    const pinOrder = (before) => {
      const kept = pins.filter((p) => p !== d.from), at = before ? kept.indexOf(before) : -1;
      kept.splice(at < 0 ? kept.length : at, 0, d.from);
      return kept;
    };
    // What letting go would do, and the gap that shows it: above a row (its address), after a section's last row
    // (`end-…`), right under an empty section's label (`head-…`), or none (a folded or busy destination).
    const plan = (() => {
      const to = lifted && d.target;
      if (!to || (to.section === from && from !== "pinned")) return null;
      if (to.section === "pinned") {
        const order = pinOrder(to.before);
        if (from === "pinned" && order.join("\n") === pins.join("\n")) return null;
        return { section: "pinned", order, gap: to.before ?? (others(pinned).length ? "end-pinned" : "head-pinned") };
      }
      // Busy work can't be settled (new work brings it straight back); out of Pinned it joins the Working shelf.
      if (busy(lifted)) return to.section === "settled" ? null : { section: "active", gap: null };
      if (to.section === "settled") return { section: "settled", gap: !this.open ? null : others(put)[0]?.address ?? "head-settled" };
      const rest = others(out), at = from === "settled" || from === "snoozed" ? 0 : rest.filter((x) => newest(x, lifted) < 0).length;
      return { section: "active", gap: !rest.length ? "head-active" : rest[at]?.address ?? "end-active" };
    })();
    const target = dragging ? d.target?.section ?? null : null;
    // A section lights up as the target, as T3's labels and shelf header do.
    const hot = (s) => target === s && (Boolean(plan) || s === from);
    const verb = !plan ? null : plan.section === "pinned" ? (from === "pinned" ? null : "pin")
      : plan.section === "settled" ? "settle" : from === "pinned" ? "unpin" : from === "settled" ? "unsettle" : from === "snoozed" ? "wake" : null;
    const BADGE = { pin: ["mods/workspace-chrome/pin.svg", "Pin"], unpin: ["mods/workspace-chrome/pin-off.svg", "Unpin"],
      settle: ["mods/workspace-chrome/circle-check.svg", "Settle"], unsettle: ["mods/t3-focus/undo.svg", "Un-settle"],
      wake: ["mods/workspace-chrome/clock.svg", "Wake"] };
    const badge = (v) => h_flex().id(`badge-${v}`).h(20).px(6).gap(4).flex_none().items_center().rounded(4)
      .border(1).border_color(t.accent + "66").bg(t.accent + "1a").text_size(11).font_medium().text_color(t.accent)
      .child(svg(BADGE[v][0]).size(12).flex_none().text_color(t.accent)).child(BADGE[v][1]);

    // Settled shows one page; while a drag moves a row out of it the next row fills in, and one settled into
    // it pushes the page's last row out of sight.
    const fromPage = from === "settled" && put.indexOf(lifted) < this.limit;
    const size = this.limit + (fromPage && plan ? 1 : 0) - (plan?.section === "settled" && from !== "settled" ? 1 : 0);
    const page = this.open ? put.slice(0, size) : [];
    const rows = [...page, ...put.filter((a) => a.focused && !page.includes(a))];
    // Snoozed folds like the other shelves; the one in view stays out.
    const snzRows = this.snoozeOpen ? snz : snz.filter((a) => a.focused);

    const aim = (to, cx) => {
      if (!this.drag?.moved || JSON.stringify(this.drag.target ?? null) === JSON.stringify(to)) return;
      this.drag.target = to;
      cx.notify();
    };
    // Over a pin, the upper half drops above it and the lower half below.
    const pinNear = (a, upper) => {
      const xs = pinned.map((x) => x.address), i = xs.indexOf(a.address);
      return pinTo(xs.slice(upper && a.address !== d?.from ? i : i + 1).find((x) => x !== d?.from));
    };
    // The gap: a card and the list's 2px in Pinned and Active, a 30px slim row in Settled (stacked without gaps).
    const MOTION = { duration: 150, easing: "ease-out" };
    const cardH = lifted && from !== "settled" ? d.height : this.cardH ?? 82;
    const gap = (key) => div().id(`gap-${key}`).flex_none().h(plan?.gap !== key ? 0 : plan.section === "settled" ? 30 : cardH + 2)
      .when(dragging, (el) => el.transition("height", MOTION));
    // Each droppable row sits in a lane: the gap that opens above it, the row (folding away once the lifted one is
    // headed elsewhere, holding its place until then) with the list's spacing, and after the last, the end gap.
    const lane = (section, xs, draw, spacing) => xs.map((a, i) => v_flex().id(`lane-${a.address}`).flex_none()
      .child(gap(a.address))
      .child(v_flex().id(`hold-${a.address}`).flex_none()
        .when(dragging && d.from === a.address, (el) => el.overflow_hidden().opacity(0).h(plan ? 0 : d.height + spacing).transition("height", MOTION))
        .child(draw(a)).when(spacing > 0, (el) => el.child(div().h(spacing).flex_none())))
      .when(i === xs.length - 1, (el) => el.child(gap(`end-${section}`))));
    // T3's boundaries: Pinned and Active labels, shown only while dragging; the list opens room for them.
    const boundary = (id, text, section, to) => h_flex().id(id).flex_none().overflow_hidden().h(dragging ? 24 : 0)
      .transition("height", MOTION).px(10).gap(8).items_center().text_size(12).font_medium()
      .on_mouse_move((_e, cx) => aim(to, cx))
      .when(dragging, (el) => el.child(div().text_color(hot(section) ? t.accent : t.muted).child(text))
        .child(div().flex_1().h(1).bg(hot(section) ? t.accent + "80" : t.border)));
    // An empty section still takes a drop: T3's dashed placeholder, accent while it's the target.
    const placeholder = (section, text) => div().id(`${section}-placeholder`).h(36).mb(2).flex_none().flex().items_center().justify_center()
      .rounded(6).border(1).border_dashed().text_size(12)
      .border_color(hot(section) ? t.accent + "66" : t.border).text_color(hot(section) ? t.accent : t.muted)
      .when(hot(section), (el) => el.bg(t.accent + "0d"))
      .on_mouse_move((_e, cx) => aim({ section }, cx))
      .child(text);
    // Picked up anywhere on a row that can move (not Working, not one whose Settle is still on its way).
    const row = (el, a) => el
      .on_mouse_down("left", (e) => {
        if (sectionOf(a) === "working" || this.waiting(a.address)) return;
        this.drag = { from: a.address, at: e.position, grab: e.local_position?.y ?? 0, height: e.bounds?.height ?? 0, moved: false, target: null };
      })
      .on_mouse_move((e, cx) => {
        if (this.sweep?.moved) return sweepTo(a, cx);
        const s = sectionOf(a);
        aim(s === "pinned" ? pinNear(a, (e.local_position?.y ?? 0) < (e.bounds?.height ?? 0) / 2) : s === "working" || s === "snoozed" ? null : { section: s }, cx);
      });
    // A drag's or sweep's release doesn't also click the row or button it ends on.
    const justDropped = () => this.drag?.moved || this.sweep?.moved || Date.now() - (this.dropped ?? 0) < 250;
    const open = (a) => () => {
      if (justDropped()) return;
      run("agent.focus", { terminal: a.address });
    };
    // Says whether it moved on to another agent.
    const drop = (cx) => {
      if (!plan) return false;
      const a = lifted;
      if (plan.section === "settled") return settle([a], cx);
      if (plan.section === "pinned") setShared("agents.pins", plan.order);
      else if (pins.includes(a.address)) {
        remember("Unpinned", [a.address], snapshot([a.address], lab));
        setShared("agents.pins", pins.filter((p) => p !== a.address));
      }
      if (snoozedAt(a)) wake(a, cx);
      else if (settledAt(a)) unsettle(a, cx);
      return false;
    };

    // Sweep, T3's other drag: press a card's Settle (or a settled row's undo) and move across rows to take the
    // whole run along; letting go settles (or brings back) every row it marked.
    const sweepFrom = (action, a) => (e, cx) => {
      cx.stop_propagation();
      this.sweep = { action, origin: a.address, at: e.position, moved: false, keys: [a.address] };
    };
    // A run stays in its own section: Settle across Pinned or Active, Un-settle across Settled, Wake across Snoozed.
    const sweepList = () => this.sweep.action === "settle"
      ? (pinned.some((x) => x.address === this.sweep.origin) ? pinned : out).filter((x) => !busy(x))
      : this.sweep.action === "wake" ? snzRows : rows;
    const sweepTo = (a, cx) => {
      const xs = sweepList().map((x) => x.address), i = xs.indexOf(this.sweep.origin), j = xs.indexOf(a.address);
      if (i < 0 || j < 0) return;
      const keys = xs.slice(Math.min(i, j), Math.max(i, j) + 1);
      if (keys.join("\n") === this.sweep.keys.join("\n")) return;
      this.sweep.keys = keys;
      cx.notify();
    };
    const swept = (a) => Boolean(this.sweep?.moved && this.sweep.keys.includes(a.address));
    const finish = (cx) => {
      if (!this.drag && !this.sweep && !this.back) return;
      const moved = (dragging && drop(cx)) || (Boolean(this.sweep?.moved) && applySweep(cx));
      if (dragging || this.sweep?.moved) this.dropped = Date.now();
      this.endDrag(!moved);
    };
    const applySweep = (cx) => {
      const xs = sweepList().filter((x) => this.sweep.keys.includes(x.address));
      if (this.sweep.action === "settle") return settle(xs, cx);
      for (const a of xs) (this.sweep.action === "wake" ? wake : unsettle)(a, cx);
      return false;
    };

    // `ghost`: the copy that follows the pointer, drawn without handlers or ids the list already uses.
    const card = (a, ghost) => {
      const st = state(a), on = a.focused;
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const branch = ps.find((p) => p.pane === a.pane)?.branch;
      const going = kids.get(a.address).filter((s) => s === "working").length;
      const meta = [branch, going ? `${going} sub-agent${going > 1 ? "s" : ""} working` : null].filter(Boolean).join(" · ");
      const pic = icon(a.program, 16, t.muted);
      // Hovered, the corner offers Settle, but only for what's finished: a working or stuck tree stays in sight.
      // Pinned ones too: settling unpins, as in T3.
      const offer = !dragging && !this.sweep?.moved && this.hovered === a.address && !busy(a);
      const id = `settle-${a.address}`;
      // As in T3, the corner says the state when there's one worth saying (Working, Needs you, Done: finished
      // and not yet seen), else how long ago it last changed.
      const pill = (color, mark, label) => h_flex().id(`state-${a.address}`).h(20).gap(6).flex_none().items_center().font_medium().text_color(color)
        .child(mark).child(div().child(label));
      // Lifted, or marked by a sweep, the corner says what letting go will do instead.
      const corner = ghost ? (verb ? badge(verb) : div())
        : swept(a) ? badge("settle")
        : offer
        ? h_flex().id(id).h(20).px(6).gap(4).flex_none().items_center().rounded(6)
          .text_size(12).text_color(lit(id, t.muted)).on_hover(glow(id))
          .role("button").accessibility_label("Settle")
          .on_mouse_down("left", sweepFrom("settle", a))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (justDropped()) return;
            // The card moves away without a pointer-leave event.
            this.hovered = null;
            settle([a], cx);
            cx.notify();
          })
          .child(svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(lit(id, t.muted)))
          .child("Settle")
        : working(a)
          ? pill(t.working, svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900),
            started(a) > 0 && started(a) < Infinity ? `Working ${took(started(a), now)}` : "Working")
          : st === "blocked"
            ? pill(t.blocked, div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().flex().items_center().justify_center().child("!"), "Needs you")
            : st === "done"
              ? pill(t.ansi2, svg("mods/workspace-chrome/circle-check.svg").size(14).flex_none().text_color(t.ansi2), "Done")
              : div().id(`state-${a.address}`).flex_none().child(since(a) > 0 ? ago(since(a), now) : "");
      const base = v_flex().id(`${ghost ? "ghost-" : ""}card-${a.address}`).px(10).py(8).gap(2).flex_none().rounded(10);
      return (ghost ? base : row(base, a).role("button").accessibility_label(title(a)).on_hover(hover(a))
        // agent.focus, not pane.focus: in tabs it focuses the pane, and it picks what the agent view shows.
        .on_click(open(a)).on_size_change((size) => { this.cardH = size.height; })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(a.address); }))
        .when(on, (el) => el.bg(t.selected))
        .when(!on && !ghost && !dragging && !this.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().h(20).gap(6).items_center().text_size(12).text_color(t.dim)
          .child(avatar(a.space, a.space_name, 14))
          // Lifted, a pin keeps its glyph only while it stays among the pins.
          .when(pins.includes(a.address) && (!ghost || plan?.section === "pinned" || !plan), (el) => el.child(svg("mods/workspace-chrome/pin.svg").size(12).flex_none().text_color(t.dim)))
          .child(div().flex_1().min_w(0).truncate().child(machine ? `${a.space_name} · ${machine}` : a.space_name ?? ""))
          .child(corner))
        .child(h_flex().gap(8).items_center()
          // Only the one in view is bright, as in T3.
          .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(on ? t.foreground : t.muted).child(title(a)))
          .when(Boolean(pic), (el) => el.child(pic)))
        .when(Boolean(meta), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(meta)));
    };

    // A settled (or snoozed) row: one dim line; viewing it leaves it parked. Hovered it brightens and its time
    // becomes a bare button, as in T3: undo arrow to un-settle, clock to wake.
    const slim = (a, ghost) => {
      const on = a.focused, over = !dragging && !this.sweep?.moved && this.hovered === a.address, bright = on || over || ghost || swept(a);
      const pic = icon(a.program, 14, t.dim);
      const z = snoozedAt(a), act = z ? "wake" : "unsettle", bid = `${act}-${a.address}`;
      const undo = h_flex().id(bid).size(20).flex_none().items_center().justify_center().rounded(4)
        .on_hover(glow(bid))
        .role("button").accessibility_label(z ? "Wake" : "Unsettle")
        .on_mouse_down("left", sweepFrom(act, a))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (justDropped()) return;
          this.hovered = null;
          (z ? wake : unsettle)(a, cx);
          cx.notify();
        })
        .child(svg(z ? "mods/workspace-chrome/clock.svg" : "mods/t3-focus/undo.svg").size(14).flex_none().text_color(lit(bid, t.muted)));
      const base = h_flex().id(`${ghost ? "ghost-" : ""}slim-${a.address}`).h(30).px(10).gap(8).flex_none().items_center().rounded(8);
      return (ghost ? base : row(base, a).role("button").accessibility_label(title(a)).on_hover(hover(a)).on_click(open(a))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(a.address); }))
        .when(on, (el) => el.bg(t.selected))
        .when(!on && !ghost && !dragging && !this.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)))
        .child(h_flex().size(16).flex_none().items_center().justify_center().opacity(bright ? 1 : 0.5).when(Boolean(pic), (el) => el.child(pic)))
        .child(div().flex_1().min_w(0).truncate().text_color(bright ? t.foreground : t.muted).child(title(a)))
        .child(ghost ? (verb ? badge(verb) : div()) : swept(a) ? badge(act)
          : over ? undo : div().flex_none().text_size(12).text_color(t.dim).child(z ? wakes(z[0], now) : ago(settledAt(a)[0], now)));
    };

    // A shelf's header, folding it: label, then count and chevron at the far edge.
    const shelf = (id, label, count, open, toggle, extra) => h_flex().id(id).h(30).px(10).gap(6).flex_none().items_center()
      .text_size(12).font_medium().text_color(t.dim)
      .role("button").accessibility_label(`${open ? "Hide" : "Show"} ${label.toLowerCase()} agents`)
      .on_click((_e, cx) => {
        toggle();
        cx.notify();
      })
      .child(div().flex_1().child(label))
      .when(Boolean(extra), (el) => el.child(extra))
      .child(div().child(String(count)))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none());

    // Shelves fold by default on this screen; the one in view stays out even folded or past the page, so it's never lost.
    const busyRows = this.workOpen ? work : work.filter((a) => a.focused);
    this.ticking = busyRows.length > 0 || pinned.some(working);
    // The first shelf takes the free space above it, so both sit at the bottom.
    const shelves = v_flex().id("shelves").pt(12).flex_none()
      .when(work.length > 0, (el) => el
        .child(shelf("working-header", "Working", work.length, this.workOpen, () => {
          this.workOpen = !this.workOpen;
          localStorage.setItem("working-open", String(this.workOpen));
        }).on_mouse_move((_e, cx) => aim(null, cx)))
        .child(v_flex().gap(2).children(busyRows.map((a) => card(a)))))
      // T3's Snoozed: hidden until its time; can be dragged out (waking it), never into.
      .when(snz.length > 0, (el) => el
        .child(shelf("snoozed-header", "Snoozed", snz.length, this.snoozeOpen, () => {
          this.snoozeOpen = !this.snoozeOpen;
          localStorage.setItem("snoozed-open", String(this.snoozeOpen));
        }).on_mouse_move((_e, cx) => aim(null, cx)))
        .children(lane("snoozed", snzRows, (a) => slim(a), 0)));
    // Clear closes settled agents' panes; Herdr then closes emptied tabs. The one in view stays.
    const spaceNow = sp.find((s) => s.active), tabNow = spaceNow?.tabs.find((c) => c.active)?.id;
    const doomed = put.filter((a) => a.pane && !a.focused && a.tab !== tabNow);
    const clear = (cx) => {
      if (!this.clearing) {
        this.clearing = true;
        cx.timer.after(3000, (cx) => { this.clearing = false; cx.notify(); });
        return;
      }
      this.clearing = false;
      const gone = new Set(doomed.map((a) => a.pane));
      for (const id of new Set(doomed.map((a) => a.space))) {
        const s = sp.find((s) => s.id === id), tabs = s?.tabs.map((c) => c.id) ?? [];
        const mine = ps.filter((p) => tabs.includes(p.tab));
        // The space stays: pane.close refuses its last pane, so a space left empty gets a fresh shell tab first,
        // where its terminals are now: an unnamed space is named after that, and s.folder is only where it began.
        if (mine.every((p) => gone.has(p.pane))) run("tab.new", { space: id, folder: mine.find((p) => p.cwd)?.cwd || s.folder });
        for (const a of doomed.filter((a) => a.space === id)) run("pane.close", { pane: a.pane });
      }
      // tab.new shows the new tab; go back to where the person was.
      if (tabNow) { run("space.select", { id: spaceNow.id }); run("tab.select", { id: tabNow }); }
    };
    const clearButton = doomed.length > 0 && h_flex().id("settled-clear").h(20).px(6).flex_none().items_center().rounded(4)
      .text_color(this.clearing ? t.blocked : lit("settled-clear", t.dim)).on_hover(glow("settled-clear"))
      .role("button").accessibility_label(this.clearing ? `Close ${doomed.length} settled agents` : "Clear settled agents")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        clear(cx);
        cx.notify();
      })
      .child(this.clearing ? `Clear ${doomed.length}?` : "Clear");
    const tail = v_flex().id("settled").flex_none()
      .child(shelf("settled-header", "Settled", put.length, this.open, () => {
        this.open = !this.open;
        this.limit = FIRST;
        localStorage.setItem("open", String(this.open));
      }, clearButton).on_mouse_move((_e, cx) => aim({ section: "settled" }, cx))
        // As T3's shelf header: brighter while anything is lifted, accent as the target.
        .when(dragging, (el) => el.text_color(hot("settled") ? t.accent : t.foreground)))
      .when(dragging && others(rows).length === 0 && !(rows.length > 0 && !plan), (el) => el
        .child(plan?.gap === "head-settled" ? gap("head-settled") : placeholder("settled", "Settled")))
      .children(lane("settled", rows, (a) => slim(a), 0))
      .when(this.open && put.length > this.limit, (el) => el.child(h_flex().id("settled-more").h(30).px(10).gap(8).flex_none().items_center().rounded(8)
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label("Show more settled agents")
        .on_click((_e, cx) => {
          this.limit += MORE;
          cx.notify();
        })
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none())
        .child(`Show ${Math.min(MORE, put.length - this.limit)} more`)));

    // T3's top row: search on the left, then the space filter, new space and new agent.
    const tool = (id, label, icon, fn) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover)).on_hover(glow(id))
      .role("button").accessibility_label(label).on_click(fn)
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).text_color(lit(id, t.dim)));
    // The filter shows what it filters to: one avatar, two overlapping, or the plain filter icon.
    const scoped = sp.filter((s) => scope.includes(s.id));
    const choice = (s) => {
      const on = s.id ? scope.includes(s.id) : scope.length === 0;
      // Selection is a check badge on the icon, as in T3.
      return h_flex().id(`scope-${s.id ?? "all"}`).h(32).px(8).gap(10).flex_none().items_center().rounded(6)
        .hover((st) => st.bg(t.hover))
        .role("button").accessibility_label(s.name)
        .on_click((e, cx) => this.pick(s, e.modifiers.shift, cx))
        .child(div().relative().flex_none()
          .child(s.id ? avatar(s.id, s.name, 16) : svg("mods/workspace-chrome/folder.svg").size(16).text_color(t.muted))
          .when(on, (el) => el.child(h_flex().absolute().right(-4).bottom(-4).size(12).rounded_full().bg(t.accent)
            .border(2).border_color(t.popover).items_center().justify_center()
            .child(svg("mods/workspace-chrome/check.svg").size(7).text_color("#ffffff")))))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name));
    };
    const filter = Popover.new("focus-scope-menu").anchor("top_right").open(this.scopeOpen)
      .on_open_change((open, cx) => {
        this.scopeOpen = open;
        if (open) {
          this.search.set_value("");
          this.search.focus();
        }
        cx.notify();
      })
      .trigger(h_flex().id("focus-scope").size(26).flex_none().items_center().justify_center().rounded(6)
        .hover((s) => s.bg(t.hover)).on_hover(glow("focus-scope"))
        .role("button").accessibility_label(scoped.length ? `Filter by space: ${scoped.map((s) => s.name).join(", ")}` : "Filter by space")
        .child(scoped.length > 1
          ? h_flex().children(scoped.slice(0, 2).map((s, i) => avatar(s.id, s.name, 14).when(i > 0, (el) => el.ml(-6))))
          : scoped.length
            ? avatar(scoped[0].id, scoped[0].name, 16)
            : svg("mods/t3-focus/list-filter.svg").size(14).text_color(lit("focus-scope", t.dim))))
      .content(v_flex().id("focus-scope-panel").w(260).max_h(360).mt(4).p(6).gap(2).rounded(10)
        .bg(t.popover).border_1().border_color(t.border).text_size(13)
        .child(h_flex().h(32).px(8).gap(8).flex_none().items_center().border_b_1().border_color(t.border)
          .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(v_flex().id("focus-scope-list").min_h(0).pt(4).gap(2).overflow_y_scroll()
          .children(this.matches().map(choice))
          .when(this.matches().length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No matching spaces.")))));
    // Right edge as the brand bar's above (pr 10), so the two rows of icons line up.
    const top = h_flex().id("focus-top").h(32).pl(8).pr(10).gap(2).flex_none().items_center()
      .child(h_flex().id("focus-search").flex_1().h(26).px(10).gap(8).items_center().rounded(6)
        .text_color(lit("focus-search", t.dim)).hover((s) => s.bg(t.hover)).on_hover(glow("focus-search"))
        .role("button").accessibility_label("Search").on_click(() => run("mod.open", { name: "picker" }))
        .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(lit("focus-search", t.dim)))
        .child(div().child("Search")))
      .child(filter)
      .child(tool("focus-new-space", "New space", "folder-plus", () => run("space.new")))
      // The layout passes its own menu; docked alone, the shipped one.
      .child(tool("focus-new-agent", "New agent", "square-pen", () => run("mod.open", { name: props()?.newMenu ?? "new-menu" })));

    // T3's undo notice: "Settled, Undo" for 5 seconds at the foot of the list.
    const u = shared("t3-focus.undo"), left = u ? UNDO_MS - (now - u.at) : 0;
    if (left > 0 && this.undoTimer !== u.id) {
      this.undoTimer = u.id;
      cx.timer.after(left + 50, (cx) => cx.notify());
    }
    const undoKey = keys().find((k) => k.action === "t3-focus.undo")?.keys;
    const notice = left > 0 && h_flex().id("undo-notice").h(28).pl(18).pr(10).gap(6).flex_none().items_center().text_size(12).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(`${u.text}${u.count > 1 ? ` ${u.count}` : ""}`))
      .child(h_flex().id("undo-button").h(22).px(6).gap(4).flex_none().items_center().rounded(4)
        .text_color(lit("undo-button", t.muted)).on_hover(glow("undo-button")).hover((st) => st.bg(t.hover))
        .role("button").accessibility_label("Undo")
        .on_click((_e, cx) => { this.undo(cx); cx.notify(); })
        .child(svg("mods/t3-focus/undo.svg").size(12).flex_none().text_color(lit("undo-button", t.muted)))
        .child(undoKey ? `Undo · ${undoKey}` : "Undo"));

    return v_flex().id("t3-focus-root").relative().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change((size) => { this.height = size.height; this.width = size.width; })
      // Esc puts a lifted row back (the sidebar holds the keyboard only while something is lifted).
      .track_focus(this.keys).on_key_down((e, cx) => {
        if (e.keystroke !== "escape" || !(this.drag || this.sweep || this.back)) return;
        this.endDrag();
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        const g = this.drag ?? this.sweep;
        if (!g || (!g.moved && Math.hypot(e.position.x - g.at.x, e.position.y - g.at.y) <= 6)) return;
        if (!g.moved) { this.back = focused(); this.keys.focus(); }
        g.moved = true;
        g.last = e.local_position ?? g.last;
        if (this.drag) this.drag.y = e.local_position?.y ?? this.drag.y;
        cx.notify();
      })
      // Released anywhere in the sidebar, it lands where the gap shows.
      .on_mouse_up("left", (_e, cx) => { finish(cx); cx.notify(); })
      // Herdr reports no release outside the sidebar, so leaving decides. Off the top or bottom edge (the Pinned
      // label or the Settled shelf sit there) it lands where the badge says, as T3 keeps the last target past the
      // list's ends; off a side it goes back.
      .on_hover((on, cx) => {
        if (on || !(this.drag || this.sweep || this.back)) return;
        const p = (this.drag ?? this.sweep)?.last, w = this.width ?? Infinity, h = this.height ?? Infinity;
        const side = !p || Math.min(p.x, w - p.x) < Math.min(p.y, h - p.y);
        if (side) this.endDrag(); else finish(cx);
        cx.notify();
      })
      // In Herdr T3 the brand bar draws this row with the logo (props.topRow: false); docked alone, it's here.
      .when(props()?.topRow !== false, (el) => el.child(top))
      .child(v_flex().id("focus-list").flex_1().min_h(0).px(8).py(8).overflow_y_scroll()
        .child(boundary("pinned", "Pinned", "pinned", pinTo(others(pinned)[0]?.address)))
        .child(gap("head-pinned"))
        .children(lane("pinned", pinned, (a) => card(a), 2))
        .child(boundary("active", "Active", "active", { section: "active" }))
        .when(dragging && others(out).length === 0 && !(out.length > 0 && !plan), (el) => el
          .child(plan?.gap === "head-active" ? gap("head-active") : placeholder("active", "Active")))
        .children(lane("active", out, (a) => card(a), 2))
        .when(out.length === 0 && !dragging, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim)
          .child(every.length ? "Nothing needs you." : "No agent status yet. Agents show up here when they report their status.")))
        // While dragging, Settled shows even empty: it's where a drop settles.
        // The free space above the shelves pushes them to the bottom; a drag over it lands in Active, as T3's
        // nearest-row drop does.
        .child(div().id("active-rest").flex_1().min_h(0).on_mouse_move((_e, cx) => aim({ section: "active" }, cx)))
        .child(shelves.when(put.length > 0 || (dragging && !busy(lifted)), (el) => el.child(tail))))
      .when(Boolean(notice), (el) => el.child(notice))
      // The lifted row moves only up and down, inside the list and below the Pinned label (T3's clamps).
      .when(Boolean(lifted) && d.y != null, (el) => el.child(div().id("drag-ghost").absolute().left(8).right(8)
        .top(Math.max((props()?.topRow !== false ? 32 : 0) + 8 + 24, Math.min(d.y - d.grab, (this.height ?? Infinity) - d.height - 8)))
        .rounded(10).bg(t.selected).border(1).border_color(t.accent).shadow_lg()
        .child(from === "settled" || from === "snoozed" ? slim(lifted, true) : card(lifted, true))));
  }
}

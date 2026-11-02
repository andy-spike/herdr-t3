// New, as T3 starts a thread: pick the space (or a new one), then what to run there.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, home, layout, exec, pickFolder } from "herdr";

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

// Space avatars and where a space is now, as t3-spaces draws and says them.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const NEW = { id: "new", name: "New space" };

// A new space starts by picking its folder, as T3 adds a project: without one, Herdr would put it where the
// focused terminal is, the project you were already in. Listing goes through sh so it works on other
// machines too: the folder (with ~ expanded) as its first line, then its entries, folders ending in "/".
const LIST = 'd=$1; case $d in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac; [ -d "$d" ] || exit 1; cd "$d" && pwd && ls -1Ap';
function split(v) {
  const i = v.lastIndexOf("/");
  return i < 0 ? { dir: "~/", prefix: v } : { dir: v.slice(0, i + 1), prefix: v.slice(i + 1) };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class NewMenu extends View {
  init(_props, cx) {
    this.target = null; // the space picked; null: still picking
    this.at = 0;
    this.filter = "";
    this.agents = {}; // machine → installed agents
    this.input = InputState.new({ placeholder: "Search spaces…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; this.follow(); cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.choose(this.items()[this.at], cx); });
    this.handle = cx.focus_handle();
    // Each list is a virtual list with its own scroll handle, so the keyboard's highlight can bring its row into
    // view (a plain scrolling div can't be scrolled from code).
    this.scrolls = { spaces: VirtualListScrollHandle.new(), folders: VirtualListScrollHandle.new(), agents: VirtualListScrollHandle.new() };
    // The folder step: a path with completion, the folders in it, and the system picker.
    this.machine = props()?.machine ?? null;
    this.folder = null; // the new space's folder, once picked
    this.listing = null;
    this.path = InputState.new({ placeholder: "~/code/my-project" });
    this.path.on("change", (_e, cx) => { this.at = 0; this.follow(); this.list(cx); cx.notify(); });
    this.path.on("submit", (_e, cx) => { this.folderRows()[this.at]?.pick(cx); cx.notify(); });
    // Opened as "New space" (the + buttons, the key): straight to the folder.
    if (props()?.newSpace) this.choose(NEW, cx);
    else this.input.focus();
  }

  // Lists the folder being typed in (each folder once; a newer request wins).
  list(cx) {
    const { dir } = split(this.path.value());
    if (this.listing?.dir === dir) return;
    this.listing = { dir, loading: true };
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", LIST, "sh", dir], { on: this.machine }).catch(() => ({ code: 1 }));
      if (this.listing?.dir !== dir) return;
      const [abs, ...entries] = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      this.listing = r.code === 0 ? { dir, abs, dirs: entries.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)) } : { dir, missing: true };
      cx.notify();
    });
  }

  // An existing space already in that folder (on that machine).
  spaceAt(path) {
    const ps = panes();
    return spaces().find((s) => (s.machine ?? null) === this.machine && place(s, ps) === path);
  }

  // A folder picked: an existing space there is the one to start in, as T3 opens a project it already has.
  pickPath(path, cx) {
    const s = this.spaceAt(path);
    if (s) this.target = s;
    else {
      this.folder = path;
      const h = home(), parent = path.replace(/\/[^/]+\/?$/, "/");
      localStorage.setItem("last-parent", !this.machine && h && parent.startsWith(h) ? "~" + parent.slice(h.length) : parent);
    }
    this.at = 0;
    this.handle.focus();
    cx.notify();
  }

  folderRows() {
    const v = this.path.value(), { dir, prefix } = split(v), L = this.listing?.dir === dir ? this.listing : null;
    const rows = [];
    if (L?.abs) {
      const join = (n) => `${L.abs.replace(/\/$/, "")}/${n}`;
      if (!prefix) rows.push({ kind: "here", path: L.abs, pick: (cx) => this.pickPath(L.abs, cx) });
      const q = prefix.toLowerCase();
      for (const n of L.dirs.filter((n) => (q.startsWith(".") || !n.startsWith(".")) && n.toLowerCase().startsWith(q)).sort((a, b) => a.localeCompare(b)).slice(0, 80)) {
        rows.push({ kind: "dir", name: n, path: join(n), pick: (cx) => this.pickPath(join(n), cx), into: `${dir}${n}/` });
      }
    }
    // The system's folder picker works on this computer only.
    if (!this.machine) rows.push({ kind: "browse", pick: (cx) => cx.spawn(async (cx) => {
      const f = await pickFolder({ prompt: "Choose the new space's folder" });
      if (f) this.pickPath(f, cx);
      cx.notify();
    }) });
    return rows;
  }

  items() {
    const ps = panes(), cur = spaces().find(s => s.active), q = this.filter.toLowerCase();
    return [cur, NEW, ...spaces().filter(s => s.id !== cur?.id)].filter(Boolean)
      .filter(s => `${s.name} ${s === NEW ? "" : place(s, ps)}`.toLowerCase().includes(q));
  }

  // The popup starts fresh each time and the check asks a shell, so it shows the last list (per machine)
  // and swaps in the fresh one when it lands. Only what's installed: the rest is nothing to start.
  installed(machine, cx) {
    const key = `agents:${machine ?? ""}`;
    if (!this.agents[key]) {
      this.agents[key] = { list: JSON.parse(localStorage.getItem(key) ?? "null"), loaded: false };
      cx.spawn(async cx => {
        try {
          const list = (await knownAgents({ on: machine })).filter(a => a.installed);
          this.agents[key] = { list, loaded: true };
          localStorage.setItem(key, JSON.stringify(list));
        } catch { this.agents[key].failed = true; }
        cx.notify();
      });
    }
    return this.agents[key];
  }

  choose(s, cx) {
    if (!s) return;
    this.target = s;
    this.at = 0;
    if (s === NEW) {
      // Starts where the last new space's folder was (~/code/ say), ready to type the next one.
      this.folder = null;
      this.path.set_value(localStorage.getItem("last-parent") ?? "~/");
      this.path.focus();
      this.list(cx);
    } else this.handle.focus();
    cx.notify();
  }

  start(a) {
    closeOverlay(props().overlay);
    const what = a ? { argv: a.run } : {};
    // Starting anything here means seeing it: the agent view would keep it out of sight.
    if (find(layout(), "view")?.active === "agent") run("layout.select", { stack: "view", child: "main" });
    if (this.target === NEW) run("space.new", { folder: this.folder, ...(this.machine ? { machine: this.machine } : {}), ...(a ? { ...what, tab: a.name } : {}) });
    else run("tab.new", { space: this.target.id, ...(a ? { ...what, name: a.name } : {}) });
  }

  // Keeps the highlighted row on screen in the list showing now.
  follow() {
    this.scrolls?.[this.view]?.scroll_to_item(this.at);
  }

  // A list of rows ({ key, el, h }): only what's on screen is drawn, and it scrolls to follow the highlight.
  // The popup sizes to its content and a virtual list has none of its own, so the list gets its rows' height,
  // up to `room` (what the 420px popup leaves under the step's header).
  vlist(id, rows, room) {
    // A step just shown starts with its highlight in view, whatever it was scrolled to before.
    if (this.view !== id) this.scrolls[id].scroll_to_item(this.at);
    this.view = id;
    return div().w_full().flex_none().h(Math.max(34, Math.min(room, rows.reduce((h, r) => h + r.h, 0)))).relative()
      .child(v_virtual_list(`new-${id}`, rows.length, rows.length ? rows.map((r) => r.h) : 34, (i) => rows[i]?.key ?? String(i),
        (range) => rows.slice(range.start, range.end).map((r) => r.make())).track_scroll(this.scrolls[id]).size_full()
        .on_item_click((key, cx) => { rows.find((r) => r.key === key)?.pick?.(null, cx); cx.notify(); }));
  }

  // A row with its height (two lines with a subtitle), for vlist; built when the list draws it.
  item(...args) {
    return { key: args[0], h: args[4] ? 46 : 34, pick: args[6], make: () => this.row(...args) };
  }

  // Drawn inside a virtual list's renderer, which takes no handlers: the list reports clicks (vlist), and the
  // pointer only tints the row it's over; the keyboard's highlight is the selected fill.
  // `icon` is a function: elements are made inside the list's renderer, never carried in from render().
  row(id, i, icon, name, sub, hint) {
    const t = theme(), on = this.at === i;
    return h_flex().id(id).w_full().h(sub ? 46 : 34).px(10).gap(10).rounded(8).items_center().flex_none()
      .when(on, el => el.bg(t.selected))
      .when(!on, el => el.hover(s => s.bg(t.hover)))
      .child(h_flex().size(20).flex_none().items_center().justify_center().child(icon()))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(name))
        .when(Boolean(sub), el => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(sub))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(hint));
  }

  render(cx) {
    const t = theme(), ps = panes(), h = home();
    const short = (p) => (p && h && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "");
    const colors = shared("space.colors") ?? {};
    const keyDown = (pick, back) => (e, cx) => {
      if (e.key === "escape") return closeOverlay(props().overlay);
      if (e.key === "down") { this.at = (this.at + 1) % pick.length; this.follow(); }
      else if (e.key === "up") { this.at = (this.at + pick.length - 1) % pick.length; this.follow(); }
      else if (back && e.key === "backspace") {
        // From what to start: a new space goes back to its folder, an existing one to the spaces.
        if (this.target === NEW) { this.folder = null; this.path.focus(); } else { this.target = null; this.input.focus(); }
        this.at = 0;
      }
      else if (back && e.key === "enter") pick[this.at]?.(cx);
      else if (/^[1-9]$/.test(e.key) && (back || e.modifiers.platform)) pick[Number(e.key) - (back ? 0 : 1)]?.(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    };
    const frame = v_flex().id("new-menu").size_full().min_h(0).p(8).gap(4).bg(t.popover).text_size(13);

    if (!this.target) {
      const items = this.items();
      let n = 0;
      const rows = items.map((s, i) => {
        if (s === NEW) return this.item("space-new", i, () => svg("mods/workspace-chrome/folder-plus.svg").size(16).text_color(t.muted), "New space", null, shortcut("space.new"), (_e, cx) => this.choose(NEW, cx));
        const color = colors[s.id] ?? "ansi6", fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
        const num = ++n;
        return this.item(`space-${s.id}`, i,
          () => h_flex().size(18).rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?"),
          s.name, `${s.machine ?? "Local"} · ${short(place(s, ps))}`, num <= 9 ? `⌘${num}` : "", (_e, cx) => this.choose(s, cx));
      });
      // ⌘1… go by space number, New space aside.
      const bySpace = items.filter(s => s !== NEW).map(s => (cx) => this.choose(s, cx));
      return frame.on_key_down((e, cx) => {
          if (e.key === "down" || e.key === "up" || e.key === "escape") return keyDown(items, false)(e, cx);
          return keyDown(bySpace, false)(e, cx);
        })
        .child(h_flex().h(36).flex_none().px(10).gap(8).items_center()
          .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(div().px(10).pt(4).pb(2).text_size(11).text_color(t.dim).child("Spaces"))
        .child(this.vlist("spaces", rows, 336));
    }

    const back = (cx) => { this.target = null; this.folder = null; this.at = 0; this.input.focus(); cx.notify(); };
    const header = (title, sub, onBack) => h_flex().h(36).flex_none().px(4).gap(6).items_center()
      .child(h_flex().id("new-back").size(26).flex_none().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover(s => s.bg(t.hover))
        .role("button").accessibility_label("Back")
        .on_click((_e, cx) => onBack(cx))
        .child(svg("mods/workspace-chrome/chevron-left.svg").size(14).text_color(t.dim)))
      .child(div().flex_none().text_color(t.foreground).child(title))
      .when(Boolean(sub), el => el.child(div().min_w(0).truncate().text_color(t.dim).child(sub)));

    // Step 1 of a new space: its folder.
    if (this.target === NEW && !this.folder) {
      const rows = this.folderRows(), L = this.listing;
      const pick = rows.map((r) => r.pick);
      const folderIcon = (name) => svg(`mods/workspace-chrome/${name}.svg`).size(15).text_color(t.muted);
      const drawn = rows.map((r, i) => {
        const there = r.path && this.spaceAt(r.path);
        if (r.kind === "browse") return this.item("folder-browse", i, () => folderIcon("search"), "Choose with the system picker…", null, "", (_e, cx) => r.pick(cx));
        if (r.kind === "here") return this.item("folder-here", i, () => folderIcon("check"), there ? `Open ${there.name}` : "Use this folder", short(r.path), "↵", (_e, cx) => r.pick(cx));
        return this.item(`folder-${r.name}`, i, () => folderIcon("folder"), r.name, there ? `Open existing space ${there.name}` : null, i === this.at ? "⇥" : "", (_e, cx) => r.pick(cx));
      });
      const status = L?.missing ? "No such folder." : L?.loading ? "Reading…" : rows.every((r) => r.kind === "browse") ? "No matching folders." : null;
      return frame.on_key_down((e, cx) => {
          // Tab goes into the highlighted folder; Backspace on an empty path, or Esc, as elsewhere.
          if (e.key === "tab") {
            const r = rows[this.at];
            if (r?.into) { this.path.set_value(r.into); this.at = 0; this.follow(); this.list(cx); }
            cx.stop_propagation();
            return cx.notify();
          }
          if (e.key === "backspace" && !this.path.value() && !props()?.newSpace) { back(cx); return cx.stop_propagation(); }
          if (e.key === "down" || e.key === "up" || e.key === "escape") return keyDown(pick, false)(e, cx);
        })
        .child(header("New space", this.machine ? `on ${this.machine}` : "Pick its folder", (cx) => (props()?.newSpace ? closeOverlay(props().overlay) : back(cx))))
        .child(h_flex().h(36).flex_none().mx(4).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border)
          .child(svg("mods/workspace-chrome/folder.svg").size(14).text_color(t.dim))
          .child(Input.new(this.path).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(h_flex().px(10).pt(6).pb(2).text_size(11).text_color(t.dim)
          .child(div().flex_1().child("Folders"))
          .child(div().child("⇥ open · ↵ pick")))
        .when(Boolean(status), el => el.child(div().px(10).py(6).flex_none().text_color(t.dim).child(status)))
        .child(this.vlist("folders", drawn, status ? 266 : 296));
    }

    const space = this.target === NEW ? null : this.target;
    const got = this.installed(space ? space.machine : this.machine, cx);
    const agents = got.list ?? [];
    const picks = [() => this.start(null), ...agents.map(a => () => this.start(a))];
    return frame.track_focus(this.handle).on_key_down(keyDown(picks, true))
      // Step 2: what to start. Back from a new space's folder returns to the folder.
      .child(space ? header(space.name, short(place(space, ps)), back)
        : header("New space", short(this.folder), (cx) => { this.folder = null; this.at = 0; this.path.focus(); cx.notify(); }))
      .child(div().px(10).pt(4).pb(2).text_size(11).text_color(t.dim).child("Start"))
      .when(agents.length === 0, el => el.child(div().px(10).py(6).flex_none().text_color(t.dim)
        .child(got.failed ? "Could not load agents" : got.loaded ? "No agents installed" : "Checking installed agents…")))
      .child(this.vlist("agents", [
        this.item("terminal", 0, () => svg("icons/shell.svg").size(14).text_color(t.foreground), "Terminal", null, "", () => this.start(null)),
        ...agents.map((a, i) => this.item(a.key, i + 1, () => (a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14)), a.name, null, i < 9 ? String(i + 1) : "", () => this.start(a))),
      ], agents.length ? 336 : 306));
  }
}

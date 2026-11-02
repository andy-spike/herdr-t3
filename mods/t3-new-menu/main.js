// New, as T3 starts a thread. Three steps, each its own screen of one popup:
//   start   what to run, and an optional first message, in a space (the current one unless changed)
//   spaces  which space: the current one, the others, then New space… as an action of its own
//   folder  a new space's folder: a path with completion, its folders (git repos marked), create, the system picker
// `+` opens on start in the current space; New space (props.newSpace) opens on folder.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, closeOverlay, openOverlay, props, window, keys, shared, setShared, home, layout, exec, pickFolder } from "herdr";

const mac = () => window()?.platform === "macos";

// The key bound to a command, globally or in the shown layout, spelled for this platform.
function shortcut(name) {
  const here = `layout:${shared("layout") ?? ""}`;
  const k = keys().find(b => (b.section === "global" || b.section === here) && b.action === name);
  if (!k?.keys.trim()) return "";
  const m = mac();
  const names = m ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: m ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(x => alias[x.toLowerCase()] ?? x.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(x => held.has(x)).map(x => names[x]), label].join(m ? "" : "+");
  }).join(" ");
}
// Quick picks: ⌘1… on macOS, Ctrl+1… elsewhere (plain digits type into the field).
const quickKey = (e) => (mac() ? e.modifiers.platform : e.modifiers.control);
const quickHint = (n) => (n > 9 ? "" : mac() ? `⌘${n}` : `Ctrl ${n}`);

// Space avatars and where a space is now, as t3-spaces draws and says them.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const NEW = { id: "new", name: "New space" };
const W = "mods/workspace-chrome/";

// Listing goes through sh so it works on other machines too: the folder (with ~ expanded) as its first line,
// then its entries (folders end in "/"), then after a --git-- line the folders that are git checkouts.
const EXPAND = 'd=$1; case $d in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac;';
const LIST = `${EXPAND} [ -d "$d" ] || exit 1; cd "$d" && pwd && ls -1Ap && echo --git-- && for x in */ .*/; do case $x in ./|../) continue;; esac; [ -e "$x.git" ] && printf '%s\\n' "\${x%/}"; done; true`;
const MKDIR = `${EXPAND} mkdir -p -- "$d" && cd "$d" && pwd`;
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
    this.agents = {}; // machine → installed agents
    this.handle = cx.focus_handle();
    // Each list is a virtual list with its own scroll handle, so the keyboard's highlight can bring its row
    // into view (a plain scrolling div can't be scrolled from code).
    this.scrolls = { spaces: VirtualListScrollHandle.new(), folder: VirtualListScrollHandle.new(), start: VirtualListScrollHandle.new() };
    this.at = 0;

    this.search = InputState.new({ placeholder: "Search spaces, or type a path for a new one…" });
    this.search.on("change", (_e, cx) => { this.at = -1; cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.pickAt(cx); });

    this.machine = props()?.machine ?? null;
    this.folder = null; // the new space's folder, once picked
    this.listing = null;
    this.path = InputState.new({ placeholder: "~/code/my-project" });
    this.path.on("change", (_e, cx) => { this.at = -1; this.error = null; this.list(cx); cx.notify(); });
    this.path.on("submit", (_e, cx) => { this.pickAt(cx); });

    this.task = InputState.new({ placeholder: "First message for the agent (optional)" });
    this.task.on("submit", (_e, cx) => { this.pickAt(cx); });

    if (props()?.newSpace) this.newSpace(cx);
    else this.go("start", spaces().find(s => s.active) ?? null, cx);
  }

  // ---- steps -------------------------------------------------------------------------------------------

  // Shows a step: start (in `target`), spaces, or folder. at = -1: the step picks its own first row.
  go(step, target, cx) {
    this.step = step;
    if (step === "start") {
      this.target = target;
      if (!target) return this.go("spaces", null, cx);
      this.task.focus();
    } else if (step === "spaces") {
      this.search.set_value("");
      this.search.focus();
    } else this.path.focus();
    this.at = -1;
    cx?.notify();
  }

  // New space: its folder first, starting where the last new space's folder was (~/code/ say), or `path`.
  newSpace(cx, path) {
    this.target = NEW;
    this.projectName = null;
    this.folder = null;
    this.path.set_value(path ?? localStorage.getItem("last-parent") ?? "~/");
    this.list(cx);
    this.go("folder", NEW, cx);
  }

  // Back one step: start ← spaces; a new space's start ← its folder; folder ← spaces (unless opened on it).
  back(cx) {
    // A saved project goes back to the list it was picked from; a picked folder, to the folder step.
    if (this.step === "start" && this.target === NEW && this.projectName) { this.projectName = null; this.folder = null; this.target = null; return this.go("spaces", null, cx); }
    if (this.step === "start" && this.target === NEW) { this.folder = null; return this.go("folder", NEW, cx); }
    if (this.step === "folder" && props()?.newSpace) return closeOverlay(props().overlay);
    if (this.step === "spaces" && this.target && this.target !== NEW) return this.go("start", this.target, cx);
    this.go("spaces", null, cx);
  }

  // ---- folder step -------------------------------------------------------------------------------------

  // Lists the folder being typed in (each folder once; a newer request wins).
  list(cx) {
    const { dir } = split(this.path.value());
    if (this.listing?.dir === dir) return;
    this.listing = { dir, loading: true };
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", LIST, "sh", dir], { on: this.machine }).catch(() => ({ code: 1 }));
      if (this.listing?.dir !== dir) return;
      if (r.code !== 0) this.listing = { dir, missing: true };
      else {
        const [head, tail = ""] = r.stdout.split("\n--git--\n");
        const [abs, ...entries] = head.split("\n").filter(Boolean);
        this.listing = { dir, abs, dirs: entries.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)), git: new Set(tail.split("\n").filter(Boolean)) };
      }
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
    if (s) return this.go("start", s, cx);
    this.folder = path;
    this.projectName = null;
    // A folder picked for a new space is a project from now on, as T3 keeps a project you add (t3-projects
    // edits and removes them).
    const saved = shared("t3.projects") ?? [];
    if (!saved.some((p) => p.path === path && (p.machine ?? null) === this.machine)) {
      setShared("t3.projects", [...saved, { path, name: path.replace(/\/+$/, "").split("/").pop() || path, machine: this.machine }]);
    }
    const h = home(), parent = path.replace(/\/[^/]+\/?$/, "/");
    localStorage.setItem("last-parent", !this.machine && h && parent.startsWith(h) ? "~" + parent.slice(h.length) : parent);
    this.go("start", NEW, cx);
  }

  // The open space for a saved project, if any.
  spaceFor(p) {
    const ps = panes();
    return spaces().find((s) => (s.machine ?? null) === (p.machine ?? null) && place(s, ps) === p.path);
  }

  // A saved project: straight to what to start in it, as a new space named as saved.
  openProject(p, cx) {
    this.target = NEW;
    this.machine = p.machine ?? null;
    this.folder = p.path;
    this.projectName = p.name;
    this.go("start", NEW, cx);
  }

  // A path whose last part doesn't exist yet: make it, then use it.
  create(cx) {
    const want = this.path.value().replace(/\/+$/, "");
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", MKDIR, "sh", want], { on: this.machine }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) this.pickPath(r.stdout.trim(), cx);
      else { this.error = (r.stderr || "Couldn't create the folder").trim(); cx.notify(); }
    });
  }

  // ---- rows --------------------------------------------------------------------------------------------

  // The rows of the step showing: { key, h, make(on), pick?(cx) }; rows without pick are labels.
  rows(t, cx) {
    const ps = panes(), h = home();
    const short = (p) => (p && h && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "");
    const icon = (name, color = t.muted) => () => svg(`${W}${name}.svg`).size(15).text_color(color);
    const avatar = (s) => () => {
      const color = (shared("space.colors") ?? {})[s.id] ?? "ansi6", fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
      return h_flex().size(18).rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?");
    };
    const label = (key, text) => ({ key, h: 26, make: () => div().id(key).w_full().h(26).px(10).pt(8).text_size(11).text_color(t.dim).child(text) });
    const note = (key, text) => ({ key, h: 34, make: () => div().id(key).w_full().h(34).px(10).flex().items_center().text_color(t.dim).child(text) });
    const sep = (key) => ({ key, h: 9, make: () => div().id(key).w_full().h(9).flex().items_center().px(6).child(div().w_full().h(1).bg(t.border)) });
    const row = (key, ic, name, sub, hint, pick, opts = {}) => ({ key, h: sub ? 46 : 34, pick, make: (on) => this.row(t, key, on, ic, name, sub, hint, opts) });

    if (this.step === "spaces") {
      const q = this.search.value().trim(), ql = q.toLowerCase();
      const all = spaces(), cur = all.find((s) => s.active);
      const match = (s) => !ql || `${s.name} ${place(s, ps)}`.toLowerCase().includes(ql);
      const out = [];
      // A path typed here means a new space there.
      if (/^[~/]/.test(q)) out.push(row("space-path", icon("folder-plus"), `New space in ${q}`, "Pick or create this folder", "↵", (cx) => this.newSpace(cx, q.endsWith("/") ? q : `${q}/`)));
      let n = 0;
      const spaceRow = (s) => { const num = ++n; return row(`space-${s.id}`, avatar(s), s.name, `${s.machine ?? "This computer"} · ${short(place(s, ps))}`, quickHint(num), (cx) => this.go("start", s, cx)); };
      if (cur && match(cur)) out.push(label("label-current", "Current space"), spaceRow(cur));
      const others = all.filter((s) => s !== cur && match(s));
      if (others.length) out.push(label("label-others", "Other spaces"), ...others.map(spaceRow));
      // Saved projects (t3-projects) without a space open: one pick opens one, named as saved.
      const projects = (shared("t3.projects") ?? []).filter((p) => !this.spaceFor(p) && (!ql || `${p.name} ${p.path}`.toLowerCase().includes(ql)));
      if (projects.length) out.push(label("label-projects", "Projects"), ...projects.map((p) => {
        const num = ++n;
        return row(`project-${p.machine ?? ""}:${p.path}`, icon("folder"), p.name, `${p.machine ?? "This computer"} · ${short(p.path)}`, quickHint(num), (cx) => this.openProject(p, cx));
      }));
      if (!out.some((r) => r.pick)) out.push(note("spaces-none", "No spaces or projects match."));
      out.push(sep("sep-new"),
        row("space-new", icon("folder-plus"), "New space…", "Pick a folder for it", shortcut("t3-chrome.newspace"), (cx) => this.newSpace(cx)),
        row("space-manage", icon("settings"), "Manage projects…", null, "", () => { closeOverlay(props().overlay); openOverlay({ mod: "t3-projects", kind: "dialog", width: 600, height: 520 }); }));
      return out;
    }

    if (this.step === "folder") {
      const { dir, prefix } = split(this.path.value()), L = this.listing?.dir === dir ? this.listing : null;
      const out = [];
      if (L?.abs) {
        const join = (n) => `${L.abs.replace(/\/$/, "")}/${n}`;
        if (!prefix) {
          const there = this.spaceAt(L.abs);
          out.push(row("folder-here", icon(there ? "chevron-right" : "check"), there ? `Open ${there.name}` : "Use this folder", short(L.abs), "↵", (cx) => this.pickPath(L.abs, cx)));
        }
        const ql = prefix.toLowerCase();
        const names = L.dirs.filter((n) => (ql.startsWith(".") || !n.startsWith(".")) && n.toLowerCase().startsWith(ql))
          // Git checkouts first: they're what spaces are usually for.
          .sort((a, b) => (L.git.has(b) - L.git.has(a)) || a.localeCompare(b)).slice(0, 120);
        for (const n of names) {
          const there = this.spaceAt(join(n)), git = L.git.has(n);
          out.push(row(`folder-${n}`, icon(git ? "git-branch" : "folder"), n, there ? `Open existing space ${there.name}` : null, "", (cx) => this.pickPath(join(n), cx), { into: `${dir}${n}/`, tag: git ? "git" : null }));
        }
        // Typed a name nothing has: offer to make it.
        if (prefix && !L.dirs.includes(prefix)) out.push(row("folder-create", icon("folder-plus"), `Create ${prefix}`, `${short(join(prefix))}`, "", (cx) => this.create(cx)));
      }
      // The system's folder picker works on this computer only.
      if (!this.machine) out.push(sep("sep-browse"), row("folder-browse", icon("search"), "Choose with the system picker…", null, "", (cx) => cx.spawn(async (cx) => {
        const f = await pickFolder({ prompt: "Choose the new space's folder" });
        if (f) this.pickPath(f, cx);
        cx.notify();
      })));
      return out;
    }

    // start: the installed agents (Herdr lists them most picked first), then a plain terminal.
    const space = this.target === NEW ? null : this.target;
    const got = this.installed(space ? space.machine : this.machine, cx);
    const agents = got.list ?? [];
    const task = this.task.value().trim();
    let n = 0;
    const out = agents.map((a) => row(`agent-${a.key}`, () => (a.tint ? svg(a.icon).size(15).text_color(t.foreground) : image(a.icon).size(15)), a.name, null, quickHint(++n), (cx) => this.start(a, cx)));
    if (!agents.length) out.push(note("agents-none", got.failed ? "Couldn't list installed agents." : got.loaded ? "No agents installed." : "Checking installed agents…"));
    out.push(sep("sep-terminal"), row("terminal", () => svg("icons/shell.svg").size(15).text_color(t.foreground), "Terminal", task ? "A plain shell: the message isn't sent" : null, quickHint(++n), (cx) => this.start(null, cx)));
    return out;
  }

  // One row. Drawn inside a virtual list's renderer, which takes no handlers: the list reports clicks, the
  // pointer only tints the row it's over, and the keyboard's highlight is the selected fill.
  row(t, id, on, icon, name, sub, hint, { tag } = {}) {
    return h_flex().id(id).w_full().h(sub ? 46 : 34).px(10).gap(10).rounded(8).items_center().flex_none()
      .when(on, el => el.bg(t.selected))
      .when(!on, el => el.hover(s => s.bg(t.hover)))
      .child(h_flex().size(20).flex_none().items_center().justify_center().child(icon()))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().min_w(0).truncate().text_color(t.foreground).child(name))
          .when(Boolean(tag), el => el.child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child(tag))))
        .when(Boolean(sub), el => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(sub))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(on && this.step === "folder" && id.startsWith("folder-") && !["folder-here", "folder-create", "folder-browse"].includes(id) ? "⇥ open · ↵ pick" : hint));
  }

  // ---- keyboard ----------------------------------------------------------------------------------------

  // The highlighted row: the one the keys moved to, else the step's natural first (the last thing started,
  // on start; the current space, on spaces; Use this folder or the first match, on folder).
  current(rows) {
    if (this.at >= 0 && rows[this.at]?.pick) return this.at;
    let i = -1;
    if (this.step === "start") i = rows.findIndex((r) => r.key === (localStorage.getItem("last-start") ?? ""));
    return i >= 0 ? i : rows.findIndex((r) => r.pick);
  }

  move(rows, d) {
    const picks = rows.map((r, i) => (r.pick ? i : -1)).filter((i) => i >= 0);
    if (!picks.length) return;
    const k = picks.indexOf(this.current(rows));
    this.at = picks[(k + d + picks.length) % picks.length];
    this.scrolls[this.step].scroll_to_item(this.at);
  }

  pickAt(cx) {
    const rows = this.rows(theme(), cx);
    rows[this.current(rows)]?.pick?.(cx);
    cx.notify();
  }

  // ---- start -------------------------------------------------------------------------------------------

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

  // Starts it as a new tab in the space, in the space's own folder (left out, Herdr would use the focused
  // terminal's, which may be another project), or as a new space in the picked folder.
  start(a, _cx) {
    const task = this.task.value().trim();
    localStorage.setItem("last-start", a ? `agent-${a.key}` : "terminal");
    closeOverlay(props().overlay);
    const what = a ? { argv: a.run, ...(task ? { task } : {}) } : {};
    // A shell can't show in the agent view; t3-tabs brings the agent view back for an agent.
    if (!a && find(layout(), "view")?.active === "agent") run("layout.select", { stack: "view", child: "main" });
    if (this.target === NEW) run("space.new", { folder: this.folder, ...(this.projectName ? { name: this.projectName } : {}), ...(this.machine ? { machine: this.machine } : {}), ...what, ...(a ? { tab: a.name } : {}) });
    else run("tab.new", { space: this.target.id, folder: place(this.target, panes()), ...what, ...(a ? { name: a.name } : {}) });
  }

  // ---- drawing -----------------------------------------------------------------------------------------

  // A list of rows: only what's on screen is drawn, and it scrolls to follow the highlight. The popup sizes to
  // its content and a virtual list has none of its own, so the list gets its rows' height, up to `room`.
  vlist(id, rows, at, room) {
    if (this.view !== id) this.scrolls[id].scroll_to_item(Math.max(at, 0));
    this.view = id;
    return div().w_full().flex_none().h(Math.max(34, Math.min(room, rows.reduce((h, r) => h + r.h, 0)))).relative()
      .child(v_virtual_list(`new-${id}`, rows.length, rows.length ? rows.map((r) => r.h) : 34, (i) => rows[i]?.key ?? String(i),
        (range) => rows.slice(range.start, range.end).map((r, k) => r.make(range.start + k === at))).track_scroll(this.scrolls[id]).size_full()
        .on_item_click((key, cx) => { rows.find((r) => r.key === key)?.pick?.(cx); cx.notify(); }));
  }

  render(cx) {
    const t = theme(), ps = panes(), h = home();
    const short = (p) => (p && h && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "");
    const rows = this.rows(t, cx), at = this.current(rows);
    const field = (state, iconName) => h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border)
      .child(svg(`${W}${iconName}.svg`).size(14).flex_none().text_color(t.dim))
      .child(Input.new(state).flex_1().h_full().text_size(13).text_color(t.foreground));
    const backButton = h_flex().id("new-back").size(26).flex_none().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover(s => s.bg(t.hover))
      .role("button").accessibility_label("Back")
      .on_click((_e, cx) => this.back(cx))
      .child(svg(`${W}chevron-left.svg`).size(14).text_color(t.dim));
    const title = (text) => div().flex_none().text_color(t.foreground).font_medium().child(text);
    const hints = (text) => div().h(22).flex_none().px(10).flex().items_center().text_size(11).text_color(t.dim).child(text);
    const sp = (s) => {
      const color = (shared("space.colors") ?? {})[s.id] ?? "ansi6", fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
      return h_flex().size(16).flex_none().rounded(4).bg(fill).items_center().justify_center().text_size(10).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?");
    };

    const keyDown = (e, cx) => {
      const empty = (state) => !state.value();
      if (e.key === "escape") return closeOverlay(props().overlay);
      if (e.key === "down") this.move(rows, 1);
      else if (e.key === "up") this.move(rows, -1);
      else if (e.key === "tab" && this.step === "folder") {
        // Tab goes into the highlighted folder.
        const r = rows[at];
        const into = r?.key.startsWith("folder-") && !["folder-here", "folder-create", "folder-browse"].includes(r.key) ? `${split(this.path.value()).dir}${r.key.slice(7)}/` : null;
        if (into) { this.path.set_value(into); this.at = -1; this.list(cx); }
      }
      else if (e.key === "backspace" && (this.step === "start" ? empty(this.task) : this.step === "spaces" ? empty(this.search) : empty(this.path))) this.back(cx);
      else if (/^[1-9]$/.test(e.key) && quickKey(e)) rows.filter((r) => r.pick && r.make && /^(space-[^pnm]|project-|agent-|terminal)/.test(r.key))[Number(e.key) - 1]?.pick(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    };
    const frame = v_flex().id("new-menu").size_full().min_h(0).p(8).gap(4).bg(t.popover).text_size(13).on_key_down(keyDown);

    if (this.step === "spaces") {
      return frame
        .child(h_flex().h(36).flex_none().px(4).gap(6).items_center()
          .when(Boolean(this.target && this.target !== NEW), el => el.child(backButton))
          .child(title("Choose a space")))
        .child(field(this.search, "search"))
        .child(this.vlist("spaces", rows, at, 298))
        .child(hints(`↑↓ move · ↵ choose · ${quickHint(1).replace(/1$/, "1–9")} pick · Esc close`));
    }

    if (this.step === "folder") {
      const L = this.listing;
      const status = this.error ?? (L?.missing ? "No such folder yet." : L?.loading ? "Reading…" : null);
      return frame
        .child(h_flex().h(36).flex_none().px(4).gap(6).items_center()
          .child(backButton)
          .child(title("New space"))
          .child(div().min_w(0).truncate().text_color(t.dim).child(this.machine ? `on ${this.machine} · pick its folder` : "Pick its folder")))
        .child(field(this.path, "folder"))
        .when(Boolean(status), el => el.child(div().h(26).flex_none().px(10).flex().items_center().text_color(this.error ? t.ansi1 : t.dim).child(status)))
        .child(this.vlist("folder", rows, at, status ? 268 : 294))
        .child(hints("↑↓ move · ⇥ open folder · ↵ pick · ⌫ back · Esc close"));
    }

    // start
    const space = this.target === NEW ? null : this.target;
    // The space is a chip: click it (or ⌫ on an empty message) to start somewhere else.
    const chip = h_flex().id("new-where").h(26).px(8).gap(6).min_w(0).items_center().rounded(6).border_1().border_color(t.border)
      .hover(s => s.bg(t.hover)).role("button").accessibility_label("Change space")
      .on_click((_e, cx) => (space ? this.go("spaces", null, cx) : this.back(cx)))
      .child(space ? sp(space) : svg(`${W}folder-plus.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(space ? space.name : this.projectName ? `${this.projectName} · new space` : `New space · ${short(this.folder)}`))
      .child(svg(`${W}chevron-down.svg`).size(12).flex_none().text_color(t.dim));
    return frame
      .child(h_flex().h(36).flex_none().px(4).gap(8).items_center()
        .child(title(space ? "New tab in" : "Start in"))
        .child(chip))
      .child(field(this.task, "square-pen"))
      .child(div().h(22).flex_none().px(10).pt(6).text_size(11).text_color(t.dim).child("Start"))
      .child(this.vlist("start", rows, at, 270))
      .child(hints(`↑↓ move · ↵ start · ${quickHint(1).replace(/1$/, "1–9")} pick · ⌫ change space · Esc close`));
  }
}

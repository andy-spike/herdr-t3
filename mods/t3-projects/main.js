// Projects: the folders you open as spaces again and again, saved so the new menu (t3-new-menu) offers them in
// one pick instead of a path to type. A settings page of its own (Herdr's Settings takes no mod sections), opened
// from the sidebar footer, the new menu's Manage projects…, or the palette.
// Kept in shared state "t3.projects": [{ path, name, machine }], in the order shown.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, spaces, panes, shared, setShared, props, closeOverlay, exec, pickFolder, home } from "herdr";

const W = "mods/workspace-chrome/";
const EXPAND = 'd=$1; case $d in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac;';
// The folder, absolute, if it exists.
const RESOLVE = `${EXPAND} [ -d "$d" ] && cd "$d" && pwd`;
// The git checkouts directly in a folder, absolute.
const REPOS = `${EXPAND} [ -d "$d" ] || exit 1; cd "$d" && for x in */ .*/; do case $x in ./|../) continue;; esac; [ -e "$x.git" ] && printf '%s\\n' "$PWD/\${x%/}"; done; true`;

const list = () => shared("t3.projects") ?? [];
const save = (xs) => setShared("t3.projects", xs);
const base = (p) => p.replace(/\/+$/, "").split("/").pop() || p;
const same = (a, b) => a.path === b.path && (a.machine ?? null) === (b.machine ?? null);
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

export default class Projects extends View {
  init(_props, cx) {
    this.add = InputState.new({ placeholder: "Add a folder: ~/code/my-project" });
    this.add.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.add.on("submit", (_e, cx) => this.addPath(this.add.value().trim(), cx));
    this.rename = InputState.new({ placeholder: "Name" });
    this.rename.on("submit", (_e, cx) => this.finishRename(cx));
    this.renaming = null; // index being renamed
    this.scanDir = shared("t3.projects.scan") ?? "~/code";
    this.repos = [];
    this.handle = cx.focus_handle();
    this.add.focus();
    this.scan(cx);
  }

  // Git checkouts in the scan folder, offered as suggestions.
  scan(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", REPOS, "sh", this.scanDir]).catch(() => ({ code: 1 }));
      this.repos = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      cx.notify();
    });
  }

  addPath(raw, cx, machine = null) {
    if (!raw) return;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", RESOLVE, "sh", raw], { on: machine }).catch(() => ({ code: 1 }));
      if (r.code !== 0) { this.error = `No folder at ${raw}`; return cx.notify(); }
      const p = { path: r.stdout.trim(), name: base(r.stdout.trim()), machine };
      if (list().some((x) => same(x, p))) this.error = `${p.name} is already saved`;
      else { save([...list(), p]); this.add.set_value(""); }
      cx.notify();
    });
  }

  finishRename(cx) {
    const xs = list(), i = this.renaming;
    if (i != null && xs[i]) {
      const name = this.rename.value().trim() || base(xs[i].path);
      save(xs.map((x, k) => (k === i ? { ...x, name } : x)));
    }
    this.renaming = null;
    this.add.focus();
    cx.notify();
  }

  render(cx) {
    const t = theme(), h = home(), ps = panes();
    const short = (p) => (p && h && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "");
    const xs = list();
    const open = (p) => spaces().find((s) => (s.machine ?? null) === (p.machine ?? null) && place(s, ps) === p.path);
    const btn = (id, label, icon, fn, color = t.dim) => h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(6)
      .text_color(color).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label).on_click((_e, cx) => { fn(cx); cx.notify(); })
      .child(typeof icon === "string" && icon.length > 2 ? svg(`${W}${icon}.svg`).size(14) : div().text_size(14).child(icon));
    const textBtn = (id, label, fn) => h_flex().id(id).h(28).px(10).gap(6).flex_none().items_center().rounded(6)
      .border_1().border_color(t.border).text_size(12).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .role("button").accessibility_label(label).on_click((_e, cx) => { fn(cx); cx.notify(); }).child(label);
    const move = (i, d) => { const ys = [...xs], j = i + d; if (j < 0 || j >= ys.length) return; [ys[i], ys[j]] = [ys[j], ys[i]]; save(ys); };

    const row = (p, i) => {
      const there = open(p), editing = this.renaming === i;
      return h_flex().id(`project-${i}`).h(46).px(10).gap(10).flex_none().items_center().rounded(8).hover((s) => s.bg(t.hover))
        .child(svg(`${W}folder.svg`).size(15).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(editing
            ? h_flex().h(24).px(6).rounded(6).border_1().border_color(t.accent).child(Input.new(this.rename).flex_1().h_full().text_size(13).text_color(t.foreground))
            : h_flex().gap(6).items_center().min_w(0)
              .child(div().min_w(0).truncate().text_color(t.foreground).child(p.name))
              .when(Boolean(there), (el) => el.child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("open"))))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${p.machine ? `${p.machine} · ` : ""}${short(p.path)}`)))
        .child(btn(`up-${i}`, "Move up", "↑", () => move(i, -1)))
        .child(btn(`down-${i}`, "Move down", "↓", () => move(i, 1)))
        .child(btn(`rename-${i}`, editing ? "Save name" : "Rename", editing ? "check" : "square-pen", (cx) => {
          if (editing) return this.finishRename(cx);
          this.renaming = i;
          this.rename.set_value(p.name);
          this.rename.focus();
        }))
        .child(btn(`remove-${i}`, "Remove", "x", () => { save(xs.filter((_, k) => k !== i)); if (this.renaming === i) this.renaming = null; }, t.dim));
    };

    // Suggestions: the folders of open spaces, then git checkouts in the scan folder, not saved yet.
    const saved = (path, machine = null) => xs.some((x) => same(x, { path, machine }));
    const fromSpaces = spaces().map((s) => ({ path: place(s, ps), machine: s.machine ?? null, why: `Space ${s.name}` }))
      .filter((s) => s.path && s.path !== h && !saved(s.path, s.machine));
    const fromScan = this.repos.filter((p) => !saved(p) && !fromSpaces.some((s) => s.path === p)).map((path) => ({ path, machine: null, why: "git" }));
    const suggestions = [...fromSpaces, ...fromScan].filter((s, i, all) => all.findIndex((y) => y.path === s.path && y.machine === s.machine) === i);
    const suggestion = (s, i) => h_flex().id(`suggest-${i}`).h(34).px(10).gap(10).flex_none().items_center().rounded(8).hover((st) => st.bg(t.hover))
      .child(svg(`${W}${s.why === "git" ? "git-branch" : "folder"}.svg`).size(14).flex_none().text_color(t.dim))
      .child(div().flex_none().text_color(t.muted).child(base(s.path)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`${s.machine ? `${s.machine} · ` : ""}${short(s.path)}${s.why === "git" ? "" : ` · ${s.why}`}`))
      .child(btn(`add-${i}`, `Add ${base(s.path)}`, "plus", () => save([...list(), { path: s.path, name: base(s.path), machine: s.machine }])));

    return v_flex().id("t3-projects").size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.renaming != null) { this.renaming = null; this.add.focus(); } else closeOverlay(props().overlay);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(8)
        .child(v_flex().flex_1()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Projects"))
          .child(div().text_size(12).text_color(t.dim).child("Folders the new menu offers in one pick. A project opens as a new space, named as here.")))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().flex_1().h(34).px(10).gap(8).items_center().rounded(8).border_1().border_color(this.error ? t.ansi1 : t.border)
          .child(svg(`${W}folder-plus.svg`).size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.add).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(textBtn("add-browse", "Browse…", (cx) => cx.spawn(async (cx) => {
          const f = await pickFolder({ prompt: "Choose a project folder" });
          if (f) this.addPath(f, cx);
        }))))
      .when(Boolean(this.error), (el) => el.child(div().mt(-6).px(2).text_size(12).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("projects-body").flex_1().min_h(0).gap(2).overflow_y_scroll()
        .child(div().px(10).pb(2).text_size(11).text_color(t.dim).child(`Saved · ${xs.length}`))
        .when(xs.length === 0, (el) => el.child(div().px(10).py(8).text_color(t.dim).child("No projects yet. Add a folder above, or pick from the suggestions.")))
        .children(xs.map(row))
        .when(suggestions.length > 0, (el) => el
          .child(h_flex().px(10).pt(14).pb(2).gap(8).items_center().text_size(11).text_color(t.dim)
            .child(div().flex_1().child(`Suggestions · open spaces and git checkouts in ${this.scanDir}`))
            .child(h_flex().id("add-all").px(6).h(20).items_center().rounded(4).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
              .role("button").accessibility_label("Add all suggestions")
              .on_click((_e, cx) => { save([...list(), ...suggestions.map((s) => ({ path: s.path, name: base(s.path), machine: s.machine }))]); cx.notify(); })
              .child("Add all")))
          .children(suggestions.map(suggestion))));
  }
}

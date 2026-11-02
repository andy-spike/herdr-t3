import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Popover, InputState, Input } from "gpui-base";
import { theme, run, props, updates, layout, nextCommand, spaces, shared, setShared, openOverlay } from "herdr";

// Space avatar colors, as t3-spaces draws them (shared "space.colors").
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar shows either Spaces and Agents, or the focus list (t3-focus): a stack in the layout.
const focusing = () => find(layout(), "sidebar-lists")?.active === "focus";
// New space starts with its folder (t3-new-menu's folder step), not where the focused terminal is.
const newSpace = () => openOverlay({ mod: "t3-new-menu", kind: "dialog", width: 520, height: 420, props: { newSpace: true } });
const switchSidebar = () => run("layout.select", { stack: "sidebar-lists", child: focusing() ? "lists" : "focus" });

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    // Only the brand bar's copy takes `t3-chrome.sidebar`; the footer's has nothing to switch.
    if (props()?.footer) return;
    this.scopeOpen = false;
    this.search = InputState.new({ placeholder: "Search spaces…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => this.pick(this.matches()[0], false, cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "sidebar") switchSidebar();
        else if (c === "newspace") newSpace();
        cx.notify();
      }
    });
  }

  matches() {
    const q = this.search.value().toLowerCase();
    return [{ id: null, name: "All spaces" }, ...spaces()].filter((s) => s.name.toLowerCase().includes(q));
  }

  // The focus list's space filter (shared "t3-focus.scope"): a click shows that space alone; shift-click adds
  // or removes it and keeps the menu open, as in T3.
  pick(s, shift, cx) {
    if (!s) return;
    const scope = shared("t3-focus.scope") ?? [];
    setShared("t3-focus.scope", !s.id ? [] : !shift ? [s.id] : scope.includes(s.id) ? scope.filter((id) => id !== s.id) : [...scope, s.id]);
    if (!shift) this.scopeOpen = false;
    cx.notify();
  }

  render() {
    const t = theme();
    if (props()?.footer) {
      const row = (id, icon, label, action) => h_flex().id(id).relative().h(30).px(8).gap(8).items_center().rounded(8)
        .role("button").accessibility_label(label)
        .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(action).child(h_flex().size(18).flex_none().items_center().justify_center()
          .child(svg(`mods/t3-chrome/${icon}.svg`).size(16)))
        .child(div().flex_1().min_w(0).truncate().child(label));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(6).text_size(13)
        .child(row("settings", "settings", "Settings", () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))));
    }
    // T3's sidebar header: the Herdr logo and hide button; below, search, the sidebar mode, then (with Focus
    // showing) the space filter, new space and new agent. The bar drags the window; its
    // controls stop the press so they don't.
    const focus = focusing();
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, icon, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").accessibility_label(label)
      .on_mouse_down("left", stop).on_click(action)
      .child(svg(icon).size(14));
    const W = "mods/workspace-chrome/";
    const sp = spaces(), scope = (shared("t3-focus.scope") ?? []).filter((id) => sp.some((s) => s.id === id));
    const scoped = sp.filter((s) => scope.includes(s.id));
    const avatar = (id, name, size) => {
      const color = (shared("space.colors") ?? {})[id] ?? "ansi6";
      return h_flex().size(size).flex_none().rounded(4).bg(color.startsWith("#") ? color : MARK[color] ?? t[color])
        .items_center().justify_center().text_size(size * 0.64).font_bold().text_color("#ffffff")
        .child([...(name ?? "")][0]?.toUpperCase() ?? "?");
    };
    const choice = (s) => {
      const on = s.id ? scope.includes(s.id) : scope.length === 0;
      return h_flex().id(`scope-${s.id ?? "all"}`).h(32).px(8).gap(10).flex_none().items_center().rounded(6)
        .hover((st) => st.bg(t.hover))
        .role("button").accessibility_label(s.name)
        .on_click((e, cx) => this.pick(s, e.modifiers.shift, cx))
        .child(div().relative().flex_none()
          .child(s.id ? avatar(s.id, s.name, 16) : svg(`${W}folder.svg`).size(16).text_color(t.muted))
          .when(on, (el) => el.child(h_flex().absolute().right(-4).bottom(-4).size(12).rounded_full().bg(t.accent)
            .border(2).border_color(t.popover).items_center().justify_center()
            .child(svg(`${W}check.svg`).size(7).text_color("#ffffff")))))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name));
    };
    const filter = Popover.new("brand-scope-menu").anchor("top_right").open(this.scopeOpen)
      .on_open_change((open, cx) => {
        this.scopeOpen = open;
        if (open) {
          this.search.set_value("");
          this.search.focus();
        }
        cx.notify();
      })
      .trigger(h_flex().id("brand-scope").size(26).flex_none().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .role("button").accessibility_label(scoped.length ? `Filter by space: ${scoped.map((s) => s.name).join(", ")}` : "Filter by space")
        .child(scoped.length > 1
          ? h_flex().children(scoped.slice(0, 2).map((s, i) => avatar(s.id, s.name, 14).when(i > 0, (el) => el.ml(-6))))
          : scoped.length ? avatar(scoped[0].id, scoped[0].name, 16) : svg("mods/t3-focus/list-filter.svg").size(14)))
      .content(v_flex().id("brand-scope-panel").w(260).max_h(360).mt(4).p(6).gap(2).rounded(10)
        .bg(t.popover).border_1().border_color(t.border).text_size(13)
        .child(h_flex().h(32).px(8).gap(8).flex_none().items_center().border_b_1().border_color(t.border)
          .child(svg(`${W}search.svg`).size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .child(v_flex().id("brand-scope-list").min_h(0).pt(4).gap(2).overflow_y_scroll()
          .children(this.matches().map(choice))
          .when(this.matches().length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No matching spaces.")))));
    // Two rows: the logo and the hide button (40px), then search and the rest (32px), as the layout's 72px brand block.
    return v_flex().id("brand").size_full().bg(t.chrome).text_size(13)
      .child(h_flex().id("brand-top").h(40).flex_none().pl(12).pr(10).gap(2).items_center()
        .child(image("mods/t3-chrome/herdr.png").size(20).flex_none().rounded(5))
        // The name beside the logo, as T3's wordmark.
        .child(div().ml(6).flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child("Herdr"))
        .child(button("sidebar-toggle", "Hide sidebar", `${W}sidebar.svg`, () => run("layout.toggle", { id: "sidebar" }))))
      .child(h_flex().id("brand-tools").h(32).flex_none().pl(8).pr(10).gap(2).items_center()
        .child(h_flex().id("brand-search").flex_1().min_w(0).h(26).px(10).gap(8).items_center().rounded(6)
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .role("button").accessibility_label("Search")
          .on_mouse_down("left", stop).on_click(() => run("mod.open", { name: "picker" }))
          .child(svg(`${W}search.svg`).size(14).flex_none())
          .child(div().min_w(0).truncate().child("Search")))
        .child(button("sidebar-mode", focus ? "Show spaces and agents" : "Show focus list", `${W}${focus ? "layers" : "circle-check"}.svg`, switchSidebar))
        .when(focus, (el) => el
          .child(filter)
          .child(button("brand-new-space", "New space", `${W}folder-plus.svg`, newSpace))
          .child(button("brand-new-agent", "New agent", `${W}square-pen.svg`, () => run("mod.open", { name: "t3-new-menu" })))));
  }
}

// The repos you work on, kept as a list: each one is a space with its own
// Claude in that repo's folder. Click to go to its space (made, with claude
// running, when none is open), right-click for its menu, + to add a repo.
// Opened as a popup with props { menu: path }, it is that repo's menu.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, run, shared, setShared, pickFolder, exec, openOverlay, closeOverlay, props, notify, theme, layout } from "herdr";

const KEY = "repositories";
const AGENT = ["claude"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as in the spaces list.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// Avatar colors, the same as the spaces list's.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

const glyph = (status) => (status === "blocked" || status === "done" ? "●" : "·");
const tone = (t, status) => t[status] ?? t.unknown;

const repos = () => shared(KEY) ?? [];

// The space working in a repo: the shown one first, else the first one there.
function spaceOf(repo, sp, ps) {
  const mine = sp.filter((s) => !s.machine && (place(s, ps) === repo.path || place(s, ps)?.startsWith(repo.path + "/")));
  return mine.find((s) => s.active) ?? mine[0] ?? null;
}

function open(repo) {
  const s = spaceOf(repo, spaces(), panes());
  if (s) run("space.select", { id: s.id });
  else run("space.new", { name: repo.name, folder: repo.path, argv: AGENT });
}

export default class Repositories extends View {
  init(_props, cx) {
    if (props()?.menu) {
      this.at = 0;
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
  }

  add(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Adicionar" });
      if (!folder) return;
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
      if (!r || r.code !== 0) {
        notify({ title: "Não é um repositório git", body: folder, level: "warning" });
        return;
      }
      const path = r.stdout.replace(/\n$/, "");
      if (!repos().some((x) => x.path === path)) setShared(KEY, [...repos(), { name: base(path), path }]);
      cx.notify();
    });
  }

  menuItems() {
    const path = props().menu;
    const repo = repos().find((x) => x.path === path);
    if (!repo) return [];
    const s = spaceOf(repo, spaces(), panes());
    return [
      ...(s ? [["Nova tab com Claude", "terminal", () => run("tab.new", { space: s.id, folder: path, argv: AGENT })]] : []),
      ["Remover da lista", "x", () => setShared(KEY, repos().filter((x) => x.path !== path))],
    ];
  }

  choose(i) {
    const it = this.menuItems()[i];
    if (!it) return;
    closeOverlay(props().overlay);
    it[2]();
  }

  renderMenu(t) {
    const list = this.menuItems();
    return v_flex().id("repo-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => h_flex().id(`rm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.choose(i))
        .child(svg(`mods/workspace-chrome/${it[1]}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(it[0]))));
  }

  menu(repo) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "repositories", kind: "popup", width: 220, height: 120, props: { menu: repo.path } });
  }

  avatar(repo, s, t) {
    const color = (s && (shared("space.colors") ?? {})[s.id]) ?? "ansi5";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff")
      .when(!s, (el) => el.opacity(0.55))
      .child([...repo.name][0]?.toUpperCase() ?? "?");
  }

  row(repo, s, t) {
    const branch = s?.branch && s.branch !== "main" && s.branch !== "master" ? s.branch : "";
    return h_flex().id(`repo-${repo.path}`).px(8).h(30).flex_none().gap(9).items_center().rounded(8)
      .when(Boolean(s?.active), (el) => el.bg(t.selected))
      .when(!s?.active, (el) => el.hover((st) => st.bg(t.hover)))
      .tooltip(repo.path)
      .on_click(() => open(repo))
      .on_mouse_down("right", () => this.menu(repo))
      .child(this.avatar(repo, s, t))
      .child(div().flex_shrink(0).max_w(150).truncate().text_color(s ? t.foreground : t.muted).child(repo.name))
      .child(h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11.5).text_color(t.dim)
        .when(Boolean(branch), (el) => el.child(div().min_w(0).truncate().child(branch)))
        .when(Boolean(s), (el) => el.child(div().flex_none().text_color(tone(t, s.status)).child(glyph(s.status)))));
  }

  compact(repo, s, t) {
    return railCell(h_flex().id(`repo-${repo.path}`).w(RAIL_CELL).h(26).rounded(6).justify_center().items_center()
      .when(Boolean(s?.active), (el) => el.bg(t.selected))
      .when(!s?.active, (el) => el.hover((st) => st.bg(t.hover)))
      .tooltip(repo.name)
      .on_click(() => open(repo))
      .on_mouse_down("right", () => this.menu(repo))
      .child(this.avatar(repo, s, t)));
  }

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.renderMenu(t);
    const collapsed = narrow();
    const sp = spaces(), ps = panes();
    const list = repos();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, (el) => el.pl(0).pr(0).justify_center())
        .when(!collapsed, (el) => el.child("Repositories"))
        .child(div().id("repo-add").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Adicionar repositório")
          .on_click((_e, cx) => this.add(cx)).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar()
        .when(!list.length && !collapsed, (el) => el.child(div().px(8).h(28).flex().items_center().text_size(12).text_color(t.dim).child("Nenhum repositório")))
        .children(list.map((repo) => {
          const s = spaceOf(repo, sp, ps);
          return collapsed ? this.compact(repo, s, t) : this.row(repo, s, t);
        })));
  }
}

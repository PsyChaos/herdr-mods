// Deck: one console for the herd, a window with a tab per subject. This
// version ships the frame (header with machine chips, tab strip, keyboard) and
// the Swarm tab. A tab is one file in tabs/ plus one line in TABS (see RECIPE.md).
//
// Keys: j/k or down/up move the selection, enter acts on it, 1..9 or
// tab/shift-tab pick a tab, escape closes. While open, every tab loads every
// 4 s; nothing runs while the window is closed. Opens with ctrl-shift-i.
// Hidden prop `board`: a local board.json to read instead (a fixture).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, panes, run, exec, theme, settings, props, closeOverlay } from "herdr";
import { dot } from "./ui.js";
import swarm from "./tabs/swarm.js";

const TABS = [swarm];
const TICK_MS = 4000;

export default class Deck extends View {
  init(_props, cx) {
    this.state = {}; // tab id -> its state
    this.sel = {}; // tab id -> selected row key
    this.pos = {}; // tab id -> its position, to move on when the key is gone
    this.up = {}; // machine name ("here" for this computer) -> true reachable
    this.active = 0;
    this.h = cx.focus_handle();
    this.h.focus();
    cx.timer.after(600, () => this.h.focus());
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    this.tick(cx);
  }

  tick(cx) {
    if (this.loading) return;
    this.loading = true;
    const names = machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name);
    const board = props()?.board;
    cx.spawn(async (cx) => {
      try {
        const results = await Promise.all(TABS.map((tab) =>
          tab.load({ machines: [null, ...names], state: this.state[tab.id], board }).catch(() => null)));
        const up = {};
        results.forEach((r, i) => {
          if (!r) return;
          this.state[TABS[i].id] = r.state;
          for (const [name, s] of Object.entries(r.machines)) up[name] = (up[name] ?? true) && s === "ok";
        });
        this.up = up;
      } finally {
        this.loading = false;
        cx.notify(); // also when nothing changed: live terminals() data moves alone
      }
    });
  }

  // Keeps the selected key; when it is gone, the row now at the old position.
  rowsOf(tab) {
    const rows = tab.rows(this.state[tab.id]);
    const key = this.sel[tab.id];
    if (!rows.some((r) => r.key === key)) {
      const i = Math.min(this.pos[tab.id] ?? 0, rows.length - 1);
      this.sel[tab.id] = rows[i]?.key ?? null;
    }
    this.pos[tab.id] = Math.max(0, rows.findIndex((r) => r.key === this.sel[tab.id]));
    return rows;
  }

  move(by) {
    const tab = TABS[this.active];
    const rows = this.rowsOf(tab);
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, this.pos[tab.id] + by));
    this.sel[tab.id] = rows[i].key;
    this.pos[tab.id] = i;
  }

  go(row) {
    const target = row?.target;
    if (!target) return;
    if (target.url) return void exec("xdg-open", [target.url]).catch(() => null);
    // Remote terminals are machine-qualified (machine/tN); a string already is.
    const t = typeof target === "string" ? target : target.terminal;
    const address = typeof target === "string" || !target.machine || t.includes("/") ? t : `${target.machine}/${t}`;
    if (panes().some((p) => p.terminal === address)) run("pane.focus", { terminal: address });
    else run("terminal.peek", { terminal: address });
  }

  pick(key) {
    this.sel[TABS[this.active].id] = key;
    this.go(this.rowsOf(TABS[this.active]).find((r) => r.key === key));
  }

  key(e, cx) {
    const k = e.keystroke;
    const n = TABS.length;
    if (k === "j" || k === "down") this.move(1);
    else if (k === "k" || k === "up") this.move(-1);
    else if (k === "enter") this.go(this.rowsOf(TABS[this.active]).find((r) => r.key === this.sel[TABS[this.active].id]));
    else if (/^[1-9]$/.test(k)) this.active = Math.min(Number(k) - 1, n - 1);
    else if (k === "tab") this.active = (this.active + 1) % n;
    else if (k === "shift-tab") this.active = (this.active + n - 1) % n;
    else if (k === "escape") closeOverlay(props()?.overlay);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  header(t) {
    const chip = (name, ok) => h_flex().flex_none().h(20).px(8).gap(5).items_center().rounded(10).border(1).border_color(t.border)
      .text_size(10.5).text_color(t.muted).child(dot(t, ok ? t.done : t.border, 6)).child(name);
    const names = Object.keys(this.up).filter((n) => n !== "here").sort();
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().font_semibold().text_size(13).text_color(t.foreground).child("deck"))
      .children(["here", ...names].map((n) => chip(n, this.up[n] ?? true)));
  }

  tabs(t, mono) {
    return h_flex().h(32).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).children(TABS.map((tab, i) => {
      const s = this.state[tab.id];
      return h_flex().id(`tab-${tab.id}`).h(24).px(10).gap(6).items_center().rounded(6).cursor_pointer().text_size(12)
        .on_click((_e, cx) => { this.active = i; cx.notify(); })
        .when(i === this.active, (el) => el.bg(t.hover).text_color(t.foreground))
        .when(i !== this.active, (el) => el.text_color(t.muted))
        .child(tab.icon).child(tab.label)
        .child(div().font_family(mono).text_size(11).text_color(t.dim).child(String(s ? tab.count(s) : 0)))
        .when(Boolean(s && tab.blocked(s)), (el) => el.child(dot(t, t.blocked, 6)));
    }));
  }

  render(cx) {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const tab = TABS[this.active];
    this.rowsOf(tab);
    return v_flex().id("deck").track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.h.focus()) // no stop_propagation: the window stays draggable
      .size_full().bg(t.canvas).text_color(t.foreground).text_size(12)
      .child(this.header(t))
      .child(this.tabs(t, mono))
      .child(tab.view(this.state[tab.id], this.sel[tab.id], cx, (key) => { this.pick(key); cx.notify(); }));
  }
}

// Deck: one console for the herd, a window with a tab per subject: a header
// (machine chips, range), a tab strip and the active tab's view. A tab is one
// file in tabs/ plus one line in TABS (see RECIPE.md).
//
// Keys: j/k or down/up move the selection, enter acts on it, 1..9 or
// tab/shift-tab pick a tab, escape closes. While open, every tab loads every
// 4 s and the shared probe samples every 5 s; nothing runs while the window is
// closed. Opens with ctrl-shift-i.
// Hidden prop `board`: a local board.json to read instead (a fixture).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, panes, agents, spaces, run, exec, theme, props, closeOverlay } from "herdr";
import { dot, mono, icon, chip, segmented } from "./ui.js";
import { probeAll } from "./probe.js";
import overview from "./tabs/overview.js";
import agentsTab from "./tabs/agents.js";
import swarm from "./tabs/swarm.js";

const TABS = [overview, agentsTab, swarm];
const TICK_MS = 4000;
const PROBE_MS = 5000;
const RANGES = [{ label: "2m", n: 24 }, { label: "5m", n: 60 }, { label: "10m", n: 120 }];
const probes = {}; // machine ("here" or its name) -> MachineProbe; module scope keeps the charts across close and reopen

// Herdr's machines except those still loading; "unavailable" ones are listed but not probed.
const machineList = () => machines().filter((m) => m.name && m.layout !== "loading");

export default class Deck extends View {
  init(_props, cx) {
    this.state = {}; // tab id -> its state
    this.sel = {}; // tab id -> selected row key
    this.pos = {}; // tab id -> its position, to move on when the key is gone
    this.up = {}; // machine name ("here" for this computer) -> true reachable
    this.range = 60;
    this.query = ""; // search text, passed to every tab
    this.searching = false; // typing into the search field
    this.active = 0;
    this.h = cx.focus_handle();
    this.h.focus();
    cx.timer.after(600, () => this.h.focus());
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.timer.every(PROBE_MS, (cx) => this.sample(cx));
    // Closed time is a gap in every chart, and the next sample is a fresh baseline.
    for (const p of Object.values(probes)) {
      p.raw = null;
      for (const h of [...Object.values(p.history), ...Object.values(p.agents).map((a) => a.history)]) h.push(null);
    }
    this.sample(cx);
    this.tick(cx);
  }

  // The probe has its own timer: a stuck tab load cannot stall the charts.
  sample(cx) {
    if (this.sampling) return;
    this.sampling = true;
    const spaceMachine = new Map(spaces().map((s) => [s.space, s.machine ?? null]));
    const per = new Map([[null, {}], ...machineList().map((m) => [m.name, {}])]);
    for (const a of agents()) {
      const bucket = per.get(spaceMachine.get(a.space) ?? null);
      if (bucket) bucket[a.address.split("/").pop()] = a.address;
    }
    const list = [...per].map(([name, addresses]) => ({ name, addresses, skip: name && machineList().find((m) => m.name === name)?.layout === "unavailable" }));
    cx.spawn(async (cx) => {
      try { await probeAll(exec, probes, list); } finally { this.sampling = false; cx.notify(); }
    });
  }

  tick(cx) {
    if (this.loading) return;
    this.loading = true;
    const names = machineList().filter((m) => m.layout !== "unavailable").map((m) => m.name);
    const board = props()?.board;
    cx.spawn(async (cx) => {
      try {
        const results = await Promise.all(TABS.map((tab) =>
          tab.load({ machines: [null, ...names], state: this.state[tab.id], board, probe: probes }).catch(() => null)));
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
    const rows = tab.rows(this.state[tab.id], probes, this.query);
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
    if (target.tab) { // switch to a tab by id
      const i = TABS.findIndex((x) => x.id === target.tab);
      if (i >= 0) this.active = i;
      return;
    }
    if (target.url) return void exec("xdg-open", [target.url]).catch(() => null);
    // Remote terminals are machine-qualified (machine/tN); a string already is.
    const t = typeof target === "string" ? target : target.terminal;
    const address = typeof target === "string" || !target.machine || t.includes("/") ? t : `${target.machine}/${t}`;
    if (panes().some((p) => p.terminal === address)) run("pane.focus", { terminal: address });
    else run("terminal.peek", { terminal: address });
  }

  pick(key) {
    this.h.focus();
    this.sel[TABS[this.active].id] = key;
    this.go(this.rowsOf(TABS[this.active]).find((r) => r.key === key));
  }

  // In search mode keys are text: escape clears, enter keeps the filter.
  searchKey(e) {
    const k = e.keystroke;
    if (k === "escape") { this.query = ""; this.searching = false; } else if (k === "enter") this.searching = false;
    else if (k === "backspace") this.query = this.query.slice(0, -1);
    else if (e.key_char && !e.modifiers?.control && !e.modifiers?.alt && !e.modifiers?.cmd) this.query += e.key_char;
    else return false;
    return true;
  }

  key(e, cx) {
    const k = e.keystroke;
    const n = TABS.length;
    if (this.searching) {
      if (!this.searchKey(e)) return;
      cx.stop_propagation();
      return void cx.notify();
    }
    if (k === "/") this.searching = true;
    else if (k === "escape" && this.query) this.query = "";
    else if (k === "j" || k === "down") this.move(1);
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

  health(name) {
    const m = probes[name];
    if (!m) return "loading";
    return m.ok && this.up[name] !== false ? "ok" : "error"; // ok: its probe and every tab's load said ok
  }

  header(t) {
    const names = machineList().map((m) => m.name).sort();
    return h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().font_semibold().text_size(13).text_color(t.foreground).child("deck"))
      .children(["here", ...names].map((n) => chip(t, n, this.health(n))))
      .child(div().flex_1())
      .child(segmented(t, { id: "deck-range", options: RANGES.map((r) => r.label), selected: RANGES.findIndex((r) => r.n === this.range),
        onSelect: (i, cx) => { this.h.focus(); this.range = RANGES[i].n; cx.notify(); } }))
      .child(div().id("deck-close").flex_none().w(22).h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
        .text_size(13).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => closeOverlay(props()?.overlay))
        .child("✕"));
  }

  searchField(t) {
    const text = this.searching ? ` / ${this.query}_` : this.query ? ` / ${this.query}` : "/ search";
    return h_flex().id("deck-search").flex_none().h(22).px(8).items_center().rounded(5).border(1).cursor_pointer().text_size(11)
      .border_color(this.searching ? t.ansi4 : t.border).text_color(this.query || this.searching ? t.foreground : t.dim)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.h.focus(); this.searching = true; cx.notify(); })
      .child(text);
  }

  tabs(t) {
    return h_flex().h(32).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).children([...TABS.map((tab, i) => {
      const s = this.state[tab.id];
      const on = i === this.active;
      return h_flex().id(`tab-${tab.id}`).h(24).px(10).gap(6).items_center().rounded(6).cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.h.focus(); this.active = i; cx.notify(); })
        .when(on, (el) => el.bg(t.hover).text_color(t.foreground))
        .when(!on, (el) => el.text_color(t.muted))
        .child(icon(t, tab.icon, on ? t.ansi4 : t.dim)).child(tab.label)
        .child(div().text_size(11).text_color(t.dim).child(String(tab.count(s, probes))))
        .when(Boolean(tab.blocked(s, probes)), (el) => el.child(dot(t, t.blocked, 6)));
    }), div().flex_1(), this.searchField(t)]);
  }

  render(cx) {
    const t = theme();
    const tab = TABS[this.active];
    this.rowsOf(tab);
    return v_flex().id("deck").track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.h.focus()) // no stop_propagation: the window stays draggable
      .size_full().bg(t.canvas).text_color(t.foreground).text_size(12).font_family(mono())
      .child(this.header(t))
      .child(this.tabs(t))
      .child(tab.view(this.state[tab.id], this.sel[tab.id], cx, (key, cx) => { this.pick(key); cx.notify(); }, { range: this.range, probe: probes, t, query: this.query }));
  }
}

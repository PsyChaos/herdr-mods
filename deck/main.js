// Deck: one console for the herd, a window with a tab per subject: a header
// (machine chips, range), a tab strip and the active tab's view. A tab is one
// file in tabs/ plus one line in TABS (see RECIPE.md).
//
// Keys: j/k or down/up move the selection, enter acts on it, 1..8 or
// tab/shift-tab pick a tab, escape closes. While open, every tab loads every
// 4 s and the shared probe samples every 5 s; nothing runs while the window is
// closed. Opens with ctrl-shift-i.
// Hidden prop `board`: a local board.json to read instead (a fixture).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, panes, agents, spaces, run, exec, theme, props, closeOverlay, shared } from "herdr";
import { dot, mono, icon, chip, segmented, confirm, note, openUrl } from "./ui.js";
import { probeAll } from "./probe.js";
import overview from "./tabs/overview.js";
import agentsTab from "./tabs/agents.js";
import swarm from "./tabs/swarm.js";
import team from "./tabs/team.js";
import usage from "./tabs/usage.js";
import prs from "./tabs/prs.js";
import ports from "./tabs/ports.js";
import docker from "./tabs/docker.js";

const TABS = [overview, agentsTab, swarm, team, usage, prs, ports, docker];
const TICK_MS = 4000;
const PROBE_MS = 5000;
const RANGES = [{ label: "2m", n: 24 }, { label: "5m", n: 60 }, { label: "10m", n: 120 }];
let lastTab = null; // id of the tab used last; module scope keeps it across close and reopen
const NOTE_MS = 8000;
const TAB_FRESH_MS = 10000;
const probes = {}; // machine ("here" or its name) -> MachineProbe; module scope keeps the charts across close and reopen

// Herdr's machines except those still loading; "unavailable" ones are listed but not probed.
const machineList = () => machines().filter((m) => m.name && m.layout !== "loading");

export default class Deck extends View {
  init(_props, cx) {
    if (props()?.watch) { TABS.find((x) => x.id === props().watch)?.watch?.(cx); return; }
    this.state = {}; // tab id -> its state
    this.loading = {}; // tab id -> a load is running
    this.results = {}; // tab id -> {machine: "ok" | "error"} from its last load
    this.sel = {}; // tab id -> selected row key
    this.pos = {}; // tab id -> its position, to move on when the key is gone
    this.range = 60;
    this.query = ""; // search text, passed to every tab
    this.searching = false; // typing into the search field
    const want = shared("deck.tab");
    const id = want?.at > Date.now() - TAB_FRESH_MS ? want.id : lastTab;
    this.active = Math.max(0, TABS.findIndex((x) => x.id === id));
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

  // Each tab loads on its own: a slow one never delays another.
  tick(cx) {
    const names = machineList().filter((m) => m.layout !== "unavailable").map((m) => m.name);
    const board = props()?.board;
    for (const tab of TABS) {
      if (this.loading[tab.id]) continue;
      this.loading[tab.id] = true;
      cx.spawn(async (cx) => {
        try {
          const r = await tab.load({ machines: [null, ...names], state: this.state[tab.id], board, probe: probes }).catch(() => null);
          if (r) { this.state[tab.id] = r.state; this.results[tab.id] = r.machines; }
        } finally {
          this.loading[tab.id] = false;
          cx.notify(); // also when nothing changed: live terminals() data moves alone
        }
      });
    }
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
    if (target.url) return void openUrl(target.url);
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
    const ui = TABS[this.active].ui;
    if (ui?.dialog) { // a dialog owns the keyboard
      if (k === "enter") ui.dialog.onConfirm(cx);
      else if (k === "escape") ui.dialog.onCancel(cx);
      cx.stop_propagation();
      return void cx.notify();
    }
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
    else if (/^[1-8]$/.test(k)) this.active = Math.min(Number(k) - 1, n - 1);
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
    // A tab reports a machine only when it cannot reach it, so any non-"ok" entry is an error.
    const key = name === "here" ? "null" : name; // load results are keyed by machine name; this computer is null
    const bad = Object.values(this.results).some((r) => r?.[key] !== undefined && r[key] !== "ok");
    return m.ok && !bad ? "ok" : "error";
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
    return h_flex().h(32).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border).children([...TABS.map((tab, i) => {
      const s = this.state[tab.id];
      const on = i === this.active;
      return h_flex().id(`tab-${tab.id}`).h(24).px(7).gap(5).items_center().rounded(6).cursor_pointer()
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
    if (props()?.watch) return div().id("deck-watch");
    const t = theme();
    const tab = TABS[this.active];
    lastTab = tab.id;
    if (tab.ui?.query != null) { this.query = tab.ui.query; tab.ui.query = null; } // set by another tab
    const n = tab.ui?.note;
    const shown = n && (n.level === "error" || Date.now() - n.at < NOTE_MS) ? n : null;
    this.rowsOf(tab);
    return v_flex().id("deck").track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.h.focus()) // no stop_propagation: the window stays draggable
      .size_full().bg(t.canvas).text_color(t.foreground).text_size(12).font_family(mono())
      .child(this.header(t))
      .child(this.tabs(t))
      .child(div().relative().flex_1().min_h(0).flex().flex_col()
        .child(tab.view(this.state[tab.id], this.sel[tab.id], cx, (key, cx) => { this.pick(key); cx.notify(); }, { range: this.range, probe: probes, t, query: this.query }))
        .when(Boolean(shown), (el) => el.child(note(t, shown)))
        .when(Boolean(tab.ui?.dialog), (el) => el.child(div().absolute().top(0).left(0).size_full().bg(t.canvas).flex().items_start().justify_center().pt(40)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(confirm(t, tab.ui.dialog)))));
  }
}

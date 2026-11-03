// Usage board: every provider's rate-limit windows on this computer and
// on each connected Herdr machine.
//
// Providers come from sources/<provider>.sh (see CONTRACT.md): each script
// prints ONE line of JSON describing its plan and usage windows. The board
// refreshes every two minutes — locally `exec("sh", [script])`, remotely the
// script's text (`exec("sh", ["-c", text], { on })`), since remote machines
// keep no copy. Fails softly: a missing or broken script shows as one clear
// error line. Opens as a window ("mod.open:usage-board") or docks as a
// block in a personal layout.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, machines, props, exec, readTextFile, theme, closeOverlay } from "herdr";
import { dockSide, moveDock, hideDock } from "./dock.js";

// Data refreshes every 2 minutes; durations and "updated" ages tick by the
// minute (native `.frames`, not a timer, handles animation).
const REFRESH_MS = 2 * 60 * 1000;
const CLOCK_MS = 30 * 1000;
const SOURCES = "mods/usage-board/sources";
// Updates older than this get their age shown next to the provider.
const OLD_MS = 30 * 60 * 1000;
const SHORT = { "5h": "5h", week: "Week" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const joinKey = (machine, provider) => `${machine ?? "\u0000"}|${provider}`;
const clamp = (p) => Math.max(0, Math.min(100, p));

function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const hours = Math.floor(minutes / 60);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// "3h ago" — an age next to a percent says the numbers are old.
function age(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < 45 * 1000) return "just now";
  return `${duration(ms)} ago`;
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

// "16:39" today, "Nov 9" on another day, "passed" once past.
function resetShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.getTime() <= Date.now()) return "passed";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// 42 → "42%", 18.5 → "18.5%".
function percentText(p) {
  return `${Number.isInteger(p) ? p : Math.round(p * 10) / 10}%`;
}

// Above 80% blocked, above 50% working, else accent.
function colorOf(t, p) {
  if (p > 80) return t.blocked;
  if (p > 50) return t.working;
  return t.accent;
}

// ANSI/UTF-8 text; scripts print one line, but keep the last non-empty line.
const lastLine = (text) => {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? "";
};

export default class UsageBoard extends View {
  init(_props, cx) {
    this.gen = 0;
    this.running = false;
    this.pending = 0;
    this.note = null;
    this.entries = new Map(); // "machine|provider" → provider row facts
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.timer.every(CLOCK_MS, (cx) => cx.notify());
    this.refresh(cx);
  }

  // scripts/<provider>.sh in this mod's folder, sorted.
  async findSources() {
    // The mod runtime's fs has no readdir; list the folder with sh.
    const listing = await exec("sh", ["-c", 'for f in "$1"/*.sh; do [ -f "$f" ] && basename "$f" .sh; done', "sh", `${appHome()}/${SOURCES}`])
      .catch(() => null);
    const scripts = (listing?.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).sort();
    if (scripts.length === 0) this.note = `No scripts: expected ${SOURCES}/<provider>.sh`;
    else this.note = null;
    return scripts;
  }

  refresh(cx) {
    if (this.running) return;
    this.running = true;
    cx.spawn(async (cx) => {
      const providers = await this.findSources();
      const machinesNow = machines();
      this.pending = providers.length * machinesNow.length;
      cx.notify();
      // Local: exec runs the path. Remote: read the script's text here and run
      // it there — a remote machine keeps no copy of this mod's files.
      await Promise.all(
        providers.map(async (provider) => {
          let text = null;
          try {
            text = await readTextFile(`${appHome()}/${SOURCES}/${provider}.sh`);
            if (text == null) throw new Error("script missing");
            if (text.trim().length === 0) throw new Error("script is empty");
            text = text.replace(/\x1b/g, ""); // keep it a plain sh -c argument
          } catch (e) {
            this.add({ machine: null, provider, error: `Can't read script (${e?.message ?? e})`, label: provider });
            return;
          }
          await Promise.all(
            machinesNow.map(async (m) => {
              const key = joinKey(m.name, provider);
              if (m.layout === "unavailable" || m.layout === "loading") {
                this.add({ machine: m.name, provider, label: provider, wait: true });
                return;
              }
              const result = m.name
                ? await exec("sh", ["-c", text], { on: m.name }).then((r) => r, (e) => ({ failed: e }))
                : await exec("sh", [`${appHome()}/${SOURCES}/${provider}.sh`]).then((r) => r, (e) => ({ failed: e }));
              const entry = this.readResult(m, provider, result);
              entry.machine = m.name;
              entry.provider = provider;
              this.add(entry);
            }),
          );
        }),
      );
      this.pending = 0;
      this.running = false;
      cx.notify();
    });
  }

  // One provider line -> a row; every failure becomes a readable error.
  readResult(machine, provider, result) {
    if (result.failed) return { machine: machine.name, provider, label: provider, error: result.failed?.message ?? String(result.failed) };
    const line = lastLine(result.stdout);
    if (!line) return { machine: machine.name, provider, label: provider, error: result.code === 0 ? "Script printed nothing" : `Script failed (exit ${result.code})` };
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return { machine: machine.name, provider, label: provider, error: "Output isn't valid JSON" };
    }
    if (!data || typeof data !== "object") return { machine: machine.name, provider, label: provider, error: "Output isn't a JSON object" };
    // The provider isn't installed on that machine: no row at all.
    if (data.skip === true) return { machine: machine.name, provider, skip: true };
    // Providers without a limit window can report plain totals instead.
    const totals = (Array.isArray(data.totals) ? data.totals : [])
      .filter((x) => x && typeof x === "object" && x.text != null)
      .map((x) => ({ id: String(x.id ?? x.label ?? ""), label: String(x.label ?? x.id ?? ""), text: String(x.text) }));
    const windows = (Array.isArray(data.windows) ? data.windows : [])
      .filter((w) => w && typeof w === "object" && Number.isFinite(Number(w.used_percent)))
      .map((w) => ({ ...w, used_percent: clamp(Number(w.used_percent)), stale: w.stale === true }));
    return {
      machine: machine.name,
      provider: String(data.provider ?? provider),
      label: data.label ?? data.provider ?? provider,
      plan: data.plan ?? null,
      windows,
      totals,
      updated_at: data.updated_at ?? null,
      source: data.source ?? null,
      error: data.error ?? (data.ok === false ? "Couldn't read usage" : null),
      wait: false,
    };
  }

  // Every row has a windows list, even an error or waiting one.
  add(entry) {
    if (!entry) return;
    const key = joinKey(entry.machine, entry.provider);
    if (entry.skip) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { ...entry, windows: entry.windows ?? [], totals: entry.totals ?? [] });
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .px(6)
      .py(1)
      .rounded(5)
      .flex_none()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      // A press that isn't stopped drags the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  header(t) {
    return h_flex()
      .h(32)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(div().font_semibold().text_color(t.foreground).child("Usage"))
      .when(this.pending > 0, (el) => el.child(div().text_size(11).frames(SPIN, 90).text_color(t.accent)))
      .child(div().flex_1())
      .child(this.button(t, "refresh", "↻", (_e, cx) => this.refresh(cx)))
      .children(this.placeButtons(t));
  }

  // A window closes; a docked panel switches sides or hides.
  placeButtons(t) {
    const overlay = props()?.overlay;
    if (overlay) return [this.button(t, "close", "✕", () => closeOverlay(overlay))];
    const side = dockSide();
    if (!side) return [];
    return [
      this.button(t, "move", side === "left" ? "⇄ right" : "⇄ left", () => moveDock()),
      this.button(t, "hide", "–", () => hideDock()),
    ];
  }

  // One machine: "This computer" or its name, plus its connection state.
  machineGroup(t, machine, entries) {
    const info = machines().find((m) => m.name === machine);
    return v_flex().children([
      h_flex()
        .gap(6)
        .items_center()
        .px(10)
        .pt(8)
        .pb(2)
        .text_size(10)
        .text_color(t.dim)
        .child(div().truncate().child((machine ?? "This computer").toUpperCase()))
        .when(info?.layout === "loading", (el) => el.child(div().child("· connecting"))),
      ...entries.map((e) => this.providerRow(t, e)),
    ]);
  }

  // Provider name, plan, and only the notes that matter (old data, errors),
  // then one compact line per window.
  providerRow(t, e) {
    const staleRow = e.windows.length > 0 && e.windows.every((w) => w.stale);
    const old = e.updated_at && Date.now() - new Date(e.updated_at).getTime() > OLD_MS;
    const note = e.wait ? "connecting…" : staleRow ? "stale" : old ? age(e.updated_at) : null;
    return v_flex()
      .id(`p-${e.machine ?? "local"}-${e.provider}`)
      .px(10)
      .py(3)
      .gap(2)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .text_size(12)
          .child(div().font_semibold().truncate().text_color(e.error ? t.blocked : t.foreground).child(e.label))
          .when(Boolean(e.plan), (el) => el.child(div().text_size(10).text_color(t.dim).child(String(e.plan))))
          .child(div().flex_1())
          .when(Boolean(note), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(note))),
      )
      .when(Boolean(e.error), (el) => el.child(div().truncate().text_size(10).text_color(t.blocked).child(e.error)))
      .when(!e.error && !e.wait && e.windows.length === 0 && e.totals.length === 0, (el) =>
        el.child(div().text_size(10).text_color(t.dim).child("no data")),
      )
      .children(e.windows.map((w) => this.windowLine(t, e, w)))
      .children(e.totals.map((x) => this.totalLine(t, e, x)));
  }

  // "Today  312k tokens · 6 prompts" — for providers without a limit window.
  totalLine(t, e, x) {
    return h_flex()
      .id(`x-${e.machine ?? "local"}-${e.provider}-${x.id}`)
      .gap(6)
      .items_center()
      .text_size(10)
      .child(div().w(34).flex_none().truncate().text_color(t.muted).child(x.label))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.text));
  }

  // "5s  ▬▬▬──────  %8  16:39" — label, bar, percent, reset clock.
  windowLine(t, e, w) {
    const stale = w.stale === true;
    const color = stale ? t.dim : colorOf(t, w.used_percent);
    const bar = h_flex()
      .flex_1()
      .min_w(0)
      .h(4)
      .rounded(2)
      .bg(t.input)
      .overflow_hidden()
      // The fill grows in proportion (0..100), never wider than it should.
      .child(div().h(4).rounded(2).bg(color).flex_grow(w.used_percent))
      .child(div().h(4).flex_grow(100 - w.used_percent));
    return h_flex()
      .id(`w-${e.machine ?? "local"}-${e.provider}-${w.id ?? ""}`)
      .gap(6)
      .items_center()
      .text_size(10)
      .child(div().w(34).flex_none().truncate().text_color(t.muted).child(SHORT[w.id] ?? w.label ?? w.id ?? "?"))
      .child(bar)
      .child(div().w(34).flex_none().text_color(stale ? t.muted : color).child(percentText(w.used_percent)))
      .child(div().w(46).flex_none().truncate().text_color(t.dim).child(resetShort(w.resets_at)));
  }

  empty(t) {
    return v_flex()
      .p(16)
      .gap(6)
      .text_color(t.muted)
      .when(this.pending > 0, (el) => el.child("Reading usage…"))
      .when(this.pending === 0 && this.note, (el) =>
        el
          .child(this.note)
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(`Each provider needs a \`${SOURCES}/<provider>.sh\` script that prints one JSON line (CONTRACT.md).`),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const groups = [];
    const byMachine = new Map();
    // machines() is the truth for order (local machines first); providers keep
    // alphabetical order, same provider on two machines is two rows.
    for (const m of machines()) {
      const key = m.name ?? "\u0000";
      byMachine.set(key, []);
    }
    for (const entry of [...this.entries.values()].sort((a, b) => a.provider.localeCompare(b.provider))) {
      const key = entry.machine ?? "\u0000";
      const list = byMachine.get(key);
      if (list) list.push(entry);
      else byMachine.set(key, [entry]);
    }
    for (const [key, list] of byMachine) {
      if (list.length === 0) continue;
      groups.push(this.machineGroup(t, key === "\u0000" ? null : key, list));
    }
    const nothing = this.entries.size === 0;
    return v_flex()
      .id("usage-board")
      .size_full()
      .text_size(13)
      .child(this.header(t))
      .child(
        v_flex()
          .id("usage-list")
          .flex_1()
          .min_h(0)
          .pb(8)
          .overflow_y_scrollbar()
          .when(nothing, (el) => el.child(this.empty(t)))
          .when(!nothing && groups.length === 0, (el) => el.child(this.empty(t)))
          .children(groups),
      );
  }
}

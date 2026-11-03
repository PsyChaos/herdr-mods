// Task board: which agent leads, which tasks it handed out, and which
// provider works on each one right now.
//
// A task is any terminal started with a `task` label, usually by a lead agent:
//   hc run --bg --name <slug> --label task="<title>" --label role=<role> <agent> "<task>"
// Tasks are grouped under the terminal that started them (their parent).
// Runs as a window (ctrl-shift-g, "mod.open:task-board") or docked in a
// personal layout as block `tasks` (see dock.js).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, agents, panes, run, exec, theme, props, closeOverlay, shared, setShared } from "herdr";
import { dockSide, moveDock, hideDock } from "./dock.js";

// Durations change by the minute; nothing else here needs a timer.
const CLOCK_MS = 30000;
// Finished tasks leave terminals(); the board keeps their last facts here.
const HISTORY_KEY = "task-board.finished";
const HISTORY_MAX = 50;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORDS = {
  working: "working",
  blocked: "needs you",
  error: "error",
  idle: "idle",
  done: "done",
  running: "working",
  finished: "done",
  failed: "failed",
  stopped: "stopped",
};
// Most urgent first.
const ORDER = { blocked: 0, error: 0, failed: 1, working: 2, running: 2, done: 3, idle: 4, stopped: 5, finished: 5 };

const machineOf = (address) => (address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : null);

// A parent address on the child's machine, as terminals() writes it.
const parentOf = (kid) => {
  if (!kid.parent) return null;
  const machine = machineOf(kid.address);
  return kid.parent.includes("/") || !machine ? kid.parent : `${machine}/${kid.parent}`;
};

function icon(program, size, color) {
  if (!program?.icon) return null;
  return program.tint
    ? svg(program.icon).size(size).flex_none().text_color(color)
    : image(program.icon).w(size).h(size).flex_none();
}

function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusOf(task, reported) {
  if (task.state === "live") return reported.get(task.address) ?? task.status ?? "running";
  // Killed: done if it had finished its turn (idle) first, else stopped.
  // A killed program may still exit 0 (OpenCode does); hc's reason tells.
  if (task.reason === "killed") return ["idle", "done"].includes(task.last_status) ? "finished" : "stopped";
  if (task.exit_code === 0) return "finished";
  return task.signal || task.exit_code == null ? "stopped" : "failed";
}

// What the board keeps of a task once its terminal is gone.
const snapshot = (t) => ({
  address: t.address,
  name: t.name,
  labels: t.labels,
  program: t.program,
  agent: t.agent,
  argv: t.argv?.slice(0, 1),
  parent: t.parent,
  created_ms: t.created_ms,
  last_status: t.status ?? null,
});

const history = () => shared(HISTORY_KEY) ?? [];

const providerOf = (t) => t.program?.name || t.agent || t.argv?.[0] || "?";

// Tasks grouped by the terminal that started them, groups with urgent work first.
function groups(tasks, everyone, reported) {
  const byAddress = new Map(everyone.map((t) => [t.address, t]));
  const map = new Map();
  for (const task of tasks) {
    const lead = parentOf(task);
    const key = lead ?? "";
    if (!map.has(key)) map.set(key, { lead: byAddress.get(lead) ?? null, leadAddress: lead, where: task.labels.where, tasks: [] });
    map.get(key).tasks.push({ t: task, status: statusOf(task, reported) });
  }
  const rank = (s) => ORDER[s] ?? 9;
  const list = [...map.values()];
  for (const g of list) {
    g.tasks.sort((a, b) => rank(a.status) - rank(b.status) || (b.t.created_ms ?? 0) - (a.t.created_ms ?? 0));
  }
  return list.sort((a, b) => rank(a.tasks[0].status) - rank(b.tasks[0].status));
}

export default class TaskBoard extends View {
  init(_props, cx) {
    this.seen = new Map();
    this.resolving = new Set();
    cx.timer.every(CLOCK_MS, (cx) => cx.notify());
  }

  // Remembers live tasks; asks hc how the ones that left terminals() ended.
  track(live, cx) {
    for (const t of live) this.seen.set(t.address, snapshot(t));
    const liveAddresses = new Set(live.map((t) => t.address));
    for (const [address, snap] of this.seen) {
      if (liveAddresses.has(address) || this.resolving.has(address)) continue;
      this.resolving.add(address);
      cx.spawn(async () => {
        const facts = await exec("hc", ["get", address])
          .then((r) => JSON.parse(r.stdout))
          .catch(() => ({}));
        const ended = { ...snap, state: "finished", exit_code: facts.exit_code ?? null, signal: facts.signal ?? null, reason: facts.reason ?? null, finished_ms: facts.finished_ms ?? Date.now() };
        setShared(HISTORY_KEY, [ended, ...history().filter((h) => h.address !== address)].slice(0, HISTORY_MAX));
        this.seen.delete(address);
        this.resolving.delete(address);
      });
    }
  }

  open(task) {
    if (panes().some((p) => p.terminal === task.address)) run("pane.focus", { terminal: task.address });
    else run("terminal.peek", { terminal: task.address });
  }

  clearFinished(finished, cx) {
    const gone = new Set(finished.map((t) => t.address));
    setShared(HISTORY_KEY, history().filter((h) => !gone.has(h.address)));
    cx.spawn(async () => {
      for (const t of finished) await exec("hc", ["rm", t.address]).catch(() => null);
    });
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

  header(t, list) {
    const all = list.flatMap((g) => g.tasks);
    const live = all.filter((x) => x.t.state === "live").length;
    const finished = all.filter((x) => x.t.state !== "live").map((x) => x.t);
    return h_flex()
      .h(32)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .text_size(12)
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Tasks"))
      // The counts give way first when the panel is narrow; buttons never do.
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(`${live} active · ${finished.length} done`))
      .when(finished.length > 0, (el) =>
        el.child(this.button(t, "clear", "Clear", (_e, cx) => this.clearFinished(finished, cx))),
      )
      .children(this.windowButtons(t));
  }

  // A window closes; a docked board switches sides or hides.
  windowButtons(t) {
    const overlay = props()?.overlay;
    if (overlay) return [this.button(t, "close", "✕", () => closeOverlay(overlay))];
    const side = dockSide();
    if (!side) return [];
    return [
      this.button(t, "move", side === "left" ? "⇄ right" : "⇄ left", () => moveDock()),
      this.button(t, "hide", "–", () => hideDock()),
    ];
  }

  groupHeader(t, g) {
    const lead = g.lead;
    const name = lead ? providerOf(lead) : "No lead";
    const place = g.where ?? (g.leadAddress ? machineOf(g.leadAddress) : null);
    const pic = lead ? icon(lead.program, 12, t.foreground) : null;
    return h_flex()
      .gap(5)
      .items_center()
      .px(10)
      .pt(8)
      .pb(2)
      .text_size(10)
      .text_color(t.dim)
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().font_semibold().text_color(t.muted).child(name))
      .child(div().flex_none().child("leads"))
      .when(Boolean(place), (el) => el.child(div().truncate().child(`· ${place}`)));
  }

  // "✓ Write the usage board       OpenCode · 11m" — one line per task; the
  // status word only when it needs the person (waiting, failed, stopped).
  row(t, { t: task, status }, now) {
    const live = task.state === "live";
    const color = t[status] ?? (status === "failed" ? t.blocked : status === "finished" ? t.done : t.working);
    const spinning = status === "working" || status === "running";
    const glyph = status === "finished" ? "✓" : status === "failed" ? "✗" : spinning ? SPIN[0] : "●";
    const end = live ? now : task.finished_ms ?? now;
    const loud = ["blocked", "error", "failed", "stopped"].includes(status);
    const meta = [
      loud ? WORDS[status] : null,
      providerOf(task),
      task.created_ms ? duration(end - task.created_ms) : null,
    ].filter(Boolean);
    return h_flex()
      .id(`task-${task.address}`)
      .px(10)
      .py(3)
      .gap(6)
      .items_center()
      .text_size(12)
      .when(live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(task)))
      .child(div().w(12).flex_none().text_size(11).text_color(color).when(spinning, (el) => el.frames(SPIN, 90)).child(glyph))
      .child(div().flex_1().min_w(0).truncate().text_color(live ? t.foreground : t.muted).child(task.labels.task))
      .child(div().flex_none().text_size(10).text_color(loud ? color : t.dim).child(meta.join(" · ")));
  }

  empty(t) {
    return v_flex()
      .p(16)
      .gap(6)
      .text_color(t.muted)
      .child("No tasks yet.")
      .child(
        div()
          .text_size(11)
          .text_color(t.dim)
          .child("Tasks show up here when an agent starts another one with a `task` label."),
      );
  }

  render(cx) {
    const t = theme();
    const reported = new Map(agents().map((a) => [a.address, a.status]));
    const everyone = terminals();
    const live = everyone.filter((x) => x.labels?.task);
    this.track(live.filter((x) => x.state === "live"), cx);
    const liveAddresses = new Set(live.map((x) => x.address));
    const ended = history().filter((h) => !liveAddresses.has(h.address));
    const list = groups([...live, ...ended], everyone, reported);
    const now = Date.now();
    return v_flex()
      .id("task-board")
      .size_full()
      .text_size(13)
      .child(this.header(t, list))
      .child(
        v_flex()
          .id("task-list")
          .flex_1()
          .min_h(0)
          .pb(8)
          .overflow_y_scrollbar()
          .when(list.length === 0, (el) => el.child(this.empty(t)))
          .children(list.flatMap((g) => [this.groupHeader(t, g), ...g.tasks.map((x) => this.row(t, x, now))])),
      );
  }
}

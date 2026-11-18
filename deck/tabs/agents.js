// Deck's Agents tab: every agent terminal on every machine with its state, where
// it works, what it reports, and the CPU and memory of its process tree.
// Tasks (terminals another one started with `hc run`, or with a `task` label) sit under their
// parent row; ended ones go to a `finished` panel kept in shared("task-board.finished").
// Data: agents(), spaces(), terminals() live each render; numbers from ctx.probe.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, terminals, exec, shared, setShared } from "herdr";
import { build, summary, fmtMem, fmtCpu, filterRows, filterFinished, finishedTasks, isTask, departed, ended, remember } from "../agents-model.js";
import { thenNotify } from "../frame.js";
import { panel, table, glyph, dot, sparkline, num, textButton } from "../ui.js";

// Same key and size as the old task board, so its history carries over.
const HISTORY_KEY = "task-board.finished";
const HISTORY_MAX = 50;
const SHOWN = 10;
const history = () => shared(HISTORY_KEY) ?? [];

export const ui = { dialog: null, note: null };
const say = (text, level = "info") => { ui.note = { text, level, at: Date.now() }; };

// Finished tasks leave terminals(): remember live ones, and when one is gone ask hc how it ended.
const seen = new Map();
const resolving = new Set();
function track() {
  const live = terminals().filter((t) => isTask(t) && t.state === "live");
  for (const [address, snap] of departed(seen, resolving, live)) {
    exec("hc", ["get", address])
      .then((r) => JSON.parse(r.stdout))
      .catch(() => ({}))
      .then((facts) => {
        setShared(HISTORY_KEY, remember(history(), ended(snap, facts, Date.now()), HISTORY_MAX));
        seen.delete(address);
        resolving.delete(address);
      });
  }
}

function clearFinished(cx) {
  const gone = finishedTasks({ terminals: terminals(), history: history(), now: Date.now() }).map((f) => f.address);
  setShared(HISTORY_KEY, history().filter((h) => !gone.includes(h.address)));
  ui.dialog = null;
  say(`Cleared ${gone.length} finished task${gone.length === 1 ? "" : "s"}`, "ok");
  (async () => { for (const a of gone) await exec("hc", ["rm", a]).catch(() => null); })();
}

function askClear(n) {
  ui.dialog = {
    title: "Clear finished tasks", lines: [`Forget ${n} finished task${n === 1 ? "" : "s"} and remove them with hc rm.`], action: "Clear", destructive: true,
    onConfirm: clearFinished, onCancel: () => { ui.dialog = null; },
  };
}

// One model per render: count, blocked, rows and view share it for 100 ms.
let memo = { probe: null, at: 0, value: null };
function modelOf(probe) {
  const now = Date.now();
  if (memo.probe !== probe || now - memo.at > 100) {
    track(); // a task can appear and finish between two loads
    memo = { probe, at: now, value: build({ agents: agents(), spaces: spaces(), terminals: terminals(), probe, now }) };
  }
  return memo.value;
}

export default {
  id: "agents",
  label: "agents",
  icon: "bot",

  ui,

  async load() { track(); return { state: null, machines: {} }; },

  rows: (_state, probe, query) => filterRows(modelOf(probe).rows, query).map((r) => ({ key: r.key, target: r.target })),
  count: (_state, probe) => modelOf(probe).rows.length,
  blocked: (_state, probe) => modelOf(probe).rows.some((r) => r.state === "blocked"),

  view(_state, sel, _cx, pick, { t, probe, range, query, compact }) {
    const all = modelOf(probe);
    const m = { ...all, rows: filterRows(all.rows, query) };
    const columns = [
      { label: "agent", w: 120 },
      { label: "state", w: 86 },
      { label: "where", w: 230 },
      { label: "doing" },
      { label: "cpu ~", w: 100 },
      { label: "cpu", w: 40, align: "right" },
      { label: "mem", w: 48, align: "right" },
      { label: "up", w: 40, align: "right" },
    ];
    const rows = m.rows.map((r) => {
      const c = t[r.color] ?? t.muted;
      const pic = glyph(t, r.program, 12);
      const where = h_flex().gap(5).min_w(0).truncate()
        .when(Boolean(r.machine), (el) => el.child(div().flex_none().text_color(t.dim).child(r.machine)))
        .when(Boolean(r.repo) && !r.title, (el) => el.child(div().flex_none().text_color(t.ansi4).child(r.repo)).child(div().truncate().child(r.branch ?? "")))
        .when(Boolean(r.title), (el) => el.child(div().truncate().text_color(t.foreground).child(r.title)))
        .when(!r.repo && !r.title, (el) => el.child(div().truncate().text_color(t.muted).child(r.place)));
      return {
        key: r.key,
        cells: [
          h_flex().gap(6).items_center().min_w(0).pl(r.depth * 12).when(r.depth > 0, (el) => el.child(div().flex_none().text_color(t.dim).child("└"))).when(Boolean(pic), (el) => el.child(pic)).child(div().truncate().font_semibold().child(r.app)),
          h_flex().gap(5).items_center().min_w(0).child(dot(t, c, 6)).child(div().truncate().text_color(c).when(r.state === "blocked", (el) => el.font_semibold()).child(r.word)),
          where,
          div().truncate().text_color(t.muted).child(r.doing),
          sparkline(t, r.history.slice(-range), t.ansi2, { width: 90 }),
          num(t, fmtCpu(r.cpu), r.cpu == null ? t.dim : t.foreground, 40),
          num(t, fmtMem(r.rssKiB), r.rssKiB == null ? t.dim : t.foreground, 48),
          num(t, r.age, t.dim, 40),
        ],
        onClick: (_e, cx) => pick(r.key, cx),
      };
    });
    // compact (a narrow layout block): agent, state, up only
    const pickCols = (cols, rs, keep) => compact ? [keep.map((i) => (i === keep[0] ? { ...cols[i], w: undefined } : cols[i])),
      rs.map((r) => ({ ...r, cells: keep.map((i) => r.cells[i]) }))] : [cols, rs];
    const [shownCols, shownRows] = pickCols(columns, rows, [0, 1, 7]);
    const body = rows.length ? table(t, shownCols, shownRows, sel) : div().text_color(t.dim).child("No agents.");
    const fin = finishedTasks({ terminals: terminals(), history: history(), now: Date.now() });
    const done = filterFinished(fin, query);
    const list = done.slice(0, SHOWN);
    const fcols = [{ label: "task" }, { label: "agent", w: 100 }, { label: "ended", w: 86 }, { label: "exit", w: 90 }, { label: "took", w: 48, align: "right" }];
    const frows = list.map((f) => {
      const pic = glyph(t, f.program, 12);
      return {
        key: `done-${f.key}`,
        cells: [
          div().truncate().text_color(t.muted).child(f.title),
          h_flex().gap(6).items_center().min_w(0).when(Boolean(pic), (el) => el.child(pic)).child(div().truncate().child(f.app)),
          h_flex().gap(5).items_center().min_w(0).child(dot(t, t[f.color] ?? t.dim, 6)).child(div().truncate().text_color(t[f.color] ?? t.dim).child(f.word)),
          div().truncate().text_color(t.dim).child(f.code),
          num(t, f.duration, t.dim, 48),
        ],
      };
    });
    const [fc, fr] = pickCols(fcols, frows, [0, 2, 4]);
    const fbody = list.length ? [table(t, fc, fr, null), h_flex().justify_end()
      .child(textButton(t, { id: "clear-finished", label: "Clear", destructive: true, onPress: thenNotify(() => askClear(fin.length)) }))] : null;
    return v_flex().id("agents-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar()
      .child(panel(t, { id: "agents", icon: "bot", title: "agents", right: summary(m), body }))
      .when(Boolean(fbody), (el) => el.child(panel(t, { id: "finished", icon: "history", title: "finished", right: `${done.length}${done.length > SHOWN ? `, newest ${SHOWN}` : ""}`, body: fbody })));
  },
};

// Deck's Swarm tab: every swarm run on every Herdr machine, one box per open
// run with a table of its tasks, and a box of the latest served runs.
// Data: board.json (written by `swarm`), read each tick; who is doing what
// right now comes from terminals(), which Herdr keeps current.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, terminals, agents, theme, settings, home, knownAgents } from "herdr";
import { model, mergeBoards, liveMap, fixtureLive, providerKey, shortModel, duration, EFFORT } from "../swarm-model.js";
import { box, table, rail, glyph, dot } from "../ui.js";

const STATE_DIR = 'printf %s "${SWARM_STATE:-$HOME/.local/state/herdr-swarm}"';

const programs = new Map(); // provider key -> Program, for glyphs
let programsAsked = false;

// With the `board` prop (a fixture) nothing is live, so the board itself says who works.
// One model per render: count, blocked, rows and view share it for 100 ms.
let memo = { state: null, at: 0, value: null };
function modelOf(state) {
  const now = Date.now();
  if (memo.state !== state || now - memo.at > 100) {
    const live = state.fixture ? fixtureLive(state.boards) : liveMap(terminals(), agents());
    memo = { state, at: now, value: model(state.runs, live, now) };
  }
  return memo.value;
}
const text = (v) => (typeof v === "number" ? duration(v) : v ?? "");
const age = (run) => (Date.parse(run.created) ? duration(Date.now() - Date.parse(run.created)) : "");

// board.json's path on a machine; null while it can't be resolved (tried again next tick).
async function pathOn(state, machine) {
  const key = machine ?? "";
  if (state.paths.has(key)) return state.paths.get(key);
  try {
    const r = await exec("sh", ["-c", STATE_DIR], machine ? { on: machine } : {});
    if (r.code !== 0 || !r.stdout.startsWith("/")) throw new Error("no path");
    const path = `${r.stdout.replace(/\/+$/, "")}/board.json`;
    state.paths.set(key, path);
    return path;
  } catch {
    if (!machine) { // this computer always has a default
      const path = `${home()}/.local/state/herdr-swarm/board.json`;
      state.paths.set(key, path);
      return path;
    }
    return null;
  }
}

export default {
  id: "swarm",
  label: "swarm",
  icon: "🍳",

  async load(ctx) {
    const state = ctx.state ?? { texts: new Map(), boards: new Map(), paths: new Map(), runs: [] };
    if (!programsAsked) {
      programsAsked = true;
      knownAgents().then((known) => known.forEach((p) => programs.set(providerKey(p.key), p))).catch(() => {});
    }
    state.fixture = Boolean(ctx.board);
    const where = ctx.board ? [null] : ctx.machines; // [null, ...names]
    const status = {};
    let changed = false;
    await Promise.all(where.map(async (machine) => {
      const key = machine ?? "";
      status[machine ?? "here"] = "ok";
      let body = null;
      try {
        const path = ctx.board ?? (await pathOn(state, machine));
        if (!path) throw new Error("machine not ready");
        body = await readTextFile(path, machine ? { on: machine } : {});
      } catch {
        status[machine ?? "here"] = "error";
        if (state.texts.delete(key) || state.boards.delete(key)) changed = true; // no stale runs
        return;
      }
      if (state.texts.has(key) && state.texts.get(key) === body) return;
      changed = true;
      state.texts.set(key, body);
      if (body == null) return void state.boards.delete(key);
      try {
        state.boards.set(key, JSON.parse(body));
      } catch {
        // Written atomically, so this is rare: keep the last good board.
      }
    }));
    // A machine that went away takes its runs with it.
    for (const key of [...state.texts.keys()]) {
      if (where.some((m) => (m ?? "") === key)) continue;
      changed = true;
      state.texts.delete(key);
      state.boards.delete(key);
      state.paths.delete(key);
    }
    if (changed) state.runs = mergeBoards(state.boards).runs;
    return { state, changed, machines: status };
  },

  rows(state) {
    if (!state) return [];
    const m = modelOf(state);
    return [
      ...m.open.flatMap((o) => o.rows.map((r) => ({ key: r.key, target: r.target ?? null }))),
      ...m.served.map((s) => ({ key: s.key, target: s.target })),
    ];
  },

  count(state) {
    return state ? modelOf(state).open.flatMap((o) => o.rows).filter((r) => ["cooking", "review", "fixing", "needs you"].includes(r.state)).length : 0;
  },

  blocked(state) {
    return state ? modelOf(state).open.some((o) => o.rows.some((r) => r.state === "needs you")) : false;
  },

  view(state, sel, cx, pick) {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const m = state ? modelOf(state) : { open: [], served: [] };
    if (m.open.length + m.served.length === 0) {
      return v_flex().flex_1().items_center().justify_center().gap(6)
        .child(div().text_size(15).text_color(t.muted).child("No swarm runs."))
        .child(div().text_size(11).text_color(t.dim).child("Start one with `swarm new`."));
    }
    const color = (c) => (c === "ansi1" ? t.ansi1 ?? t.blocked : t[c] ?? t.muted);
    const columns = [
      { label: "id", w: 30, mono: true },
      { label: "task" },
      { label: "worker", w: 120 },
      { label: "model", w: 84, mono: true },
      { label: "stage", w: 56 },
      { label: "state", w: 72 },
      { label: "doing now", w: 250 },
      { label: "time", w: 40, mono: true },
    ];
    const runBox = ({ run, chef, rows }) => {
      const head = chef?.name
        ? h_flex().px(10).h(22).gap(8).items_center().text_size(11)
          .child(div().flex_none().font_family(mono).text_color(t.dim).child(`chef ${chef.name}`))
          .child(div().min_w(0).truncate().text_color(t.muted).child(chef.msg ?? ""))
        : null;
      const body = table(t, columns, rows.map((r) => {
        const c = color(r.color);
        const program = programs.get(providerKey(r.worker.provider));
        const pic = glyph(t, program, 11);
        const who = r.worker.name ?? providerKey(r.worker.provider) ?? "?";
        const effort = EFFORT[r.worker.effort] ?? r.worker.effort ?? "";
        const doing = r.doing ? `${r.doing.who ? `${r.doing.who}: ` : ""}${r.doing.msg}` : "";
        return {
          key: r.key,
          cells: [
            r.id, r.title,
            h_flex().gap(4).items_center().min_w(0).when(Boolean(pic), (el) => el.child(pic)).child(div().truncate().child(who)),
            [shortModel(r.worker.model), effort].filter(Boolean).join("·"),
            rail(t, r.stage, c, run.tasks?.find((x) => x.id === r.id)?.stages),
            div().truncate().text_color(c).when(r.state === "needs you" || r.state === "sent back", (el) => el.font_semibold()).child(r.state),
            div().truncate().text_color(t.muted).child(doing),
            div().truncate().text_color(text(r.elapsed) ? t.foreground : t.dim).child(text(r.elapsed) || "-"),
          ],
          onClick: (_e, cx) => pick(r.key, cx),
          under: r.findings?.length
            ? v_flex().pl(40).pr(10).pb(3).children(r.findings.map((f) =>
              h_flex().h(18).gap(8).text_size(10.5).items_center()
                .child(div().w(56).flex_none().text_color(f.severity === "high" ? color("ansi1") : t.muted).child(f.severity))
                .child(div().flex_none().max_w(260).truncate().font_family(mono).text_color(t.dim).child(f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : ""))
                .child(div().min_w(0).flex_1().truncate().text_color(t.muted).child(f.issue ?? ""))))
            : null,
        };
      }), sel, mono);
      return box(t, run.title ?? run.id, [run.repo_name, run.base, run.host, age(run)].filter(Boolean).join(" · "), [head, body].filter(Boolean));
    };
    const served = m.served.length
      ? box(t, "served", `${m.served.length} latest`, m.served.map((s) =>
        h_flex().id(`row-${s.key}`).h(24).px(10).gap(10).items_center().text_size(11.5)
          .when(s.key === sel, (el) => el.bg(t.hover))
          .when(Boolean(s.pr), (el) => el.cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => pick(s.key, cx)))
          .child(dot(t, t.done))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.title ?? ""))
          .child(div().flex_none().font_family(mono).text_size(10.5).text_color(t.dim).child(`${s.count} ${s.count === 1 ? "task" : "tasks"}`))
          .child(div().w(50).flex_none().font_family(mono).text_size(10.5).text_color(t.dim).child(text(s.duration) || "-"))
          .child(div().w(40).flex_none().font_family(mono).text_size(10.5).text_color(t.accent).child(s.pr ? `#${String(s.pr).match(/(\d+)\/?$/)?.[1] ?? "PR"} ↗` : ""))))
      : null;
    return v_flex().id("swarm-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar()
      .children(m.open.map(runBox)).children(served ? [served] : []);
  },
};

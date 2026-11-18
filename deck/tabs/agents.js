// Deck's Agents tab: every agent terminal on every machine with its state, where
// it works, what it reports, and the CPU and memory of its process tree.
// Data: agents(), spaces(), terminals() live each render; numbers from ctx.probe.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, terminals } from "herdr";
import { build, summary, fmtMem, fmtCpu } from "../agents-model.js";
import { panel, table, glyph, dot, sparkline, num } from "../ui.js";

// One model per render: count, blocked, rows and view share it for 100 ms.
let memo = { probe: null, at: 0, value: null };
function modelOf(probe) {
  const now = Date.now();
  if (memo.probe !== probe || now - memo.at > 100) {
    memo = { probe, at: now, value: build({ agents: agents(), spaces: spaces(), terminals: terminals(), probe, now }) };
  }
  return memo.value;
}

export default {
  id: "agents",
  label: "agents",
  icon: "bot",

  async load() { return { state: null, machines: {} }; },

  rows: (_state, probe) => modelOf(probe).rows.map((r) => ({ key: r.key, target: r.target })),
  count: (_state, probe) => modelOf(probe).rows.length,
  blocked: (_state, probe) => modelOf(probe).rows.some((r) => r.state === "blocked"),

  view(_state, sel, _cx, pick, { t, probe, range }) {
    const m = modelOf(probe);
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
        .when(Boolean(r.repo), (el) => el.child(div().flex_none().text_color(t.ansi4).child(r.repo)).child(div().truncate().child(r.branch ?? "")))
        .when(!r.repo, (el) => el.child(div().truncate().text_color(t.muted).child(r.place)));
      return {
        key: r.key,
        cells: [
          h_flex().gap(6).items_center().min_w(0).when(Boolean(pic), (el) => el.child(pic)).child(div().truncate().font_semibold().child(r.app)),
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
    const body = rows.length ? table(t, columns, rows, sel) : div().text_color(t.dim).child("No agents.");
    return v_flex().id("agents-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar()
      .child(panel(t, { id: "agents", icon: "bot", title: "agents", right: summary(m), body }));
  },
};

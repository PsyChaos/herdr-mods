// Deck's shared components. Every function takes the theme `t` first; colors
// come only from its tokens.

import { div, svg, image, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";

export const STAGES = ["fire", "cook", "taste", "review", "pass"];

export const mono = () => settings().font_family ?? "JetBrains Mono";

export const icon = (t, name, color = t.dim, size = 12) => svg(`mods/deck/icons/${name}.svg`).size(size).flex_none().text_color(color);

export const dot = (t, color, size = 7) => div().w(size).h(size).rounded(size / 2).flex_none().bg(color ?? t.border);

const GRADIENT = (t) => ({ cpu: [t.ansi2, t.ansi3, t.ansi1], mem: [t.ansi6, t.ansi4, t.ansi5], disk: [t.ansi14, t.ansi11, t.ansi1] });

// Stepped, not mixed: theme colors may be #rgb, #rrggbbaa or names.
export const band = (t, gradientName, percent) => {
  const c = GRADIENT(t)[gradientName] ?? GRADIENT(t).cpu;
  return percent < 60 ? c[0] : percent < 85 ? c[1] : c[2];
};

// A fieldset: the title is cut into the top border. Body: element or array.
export function panel(t, { id, icon: name, title, accent = t.ansi4, right = "", body }) {
  const line = (w) => (w ? div().w(w).flex_none() : div().flex_1().min_w(8)).h(1).mt(9).bg(t.border);
  const corner = (left) => {
    const c = div().w(10).h(9).flex_none().mt(9).border_t(1).border_color(t.border);
    return left ? c.border_l(1).rounded_tl(8) : c.border_r(1).rounded_tr(8);
  };
  const cap = (el) => h_flex().h(18).flex_none().px(6).gap(5).items_center().child(el);
  const top = h_flex().w_full().h(18).items_start()
    .child(corner(true)).child(line(4))
    .child(cap(h_flex().gap(5).items_center().when(Boolean(name), (el) => el.child(icon(t, name, accent)))
      .child(div().flex_none().font_semibold().text_color(accent).child(title))))
    .child(line())
    .when(Boolean(right), (el) => el.child(cap(div().text_size(11).text_color(t.dim).child(right))).child(line(4)))
    .child(corner(false));
  const content = v_flex().px(12).pt(10).pb(12).gap(8).border_l(1).border_r(1).border_b(1).border_color(t.border)
    .rounded_bl(8).rounded_br(8).children([body].flat().filter(Boolean));
  return v_flex().id(id).flex_none().mx(12).mt(12).child(top).child(content);
}

export const rowLabel = (t, iconName, word) => h_flex().w(54).flex_none().gap(5).items_center().text_color(t.dim)
  .child(icon(t, iconName)).child(word);

// Cells of their own position on the gradient; the rest `hover`.
export function meter(t, percent, cells = 24, gradientName = "cpu") {
  const lit = Number.isFinite(percent) && percent > 0 ? Math.max(1, Math.round((Math.min(percent, 100) / 100) * cells)) : 0;
  return h_flex().flex_none().h(11).gap(2).items_stretch().children(Array.from({ length: cells }, (_u, i) =>
    div().w(5).rounded(1).bg(i < lit ? band(t, gradientName, ((i + 1) / cells) * 100) : t.hover)));
}

export const coreCells = (t, percents) => h_flex().flex_wrap().gap(2).children(percents.map((p) =>
  div().w(11).h(11).rounded(2).flex_none().bg(Number.isFinite(p) ? band(t, "cpu", p) : t.hover)));

// Paths in percent coordinates, from herdwatch charts.js; runs break at null.
const pc = (v) => `${v.toFixed(2)}%`;
function runs(samples, max) {
  const out = [];
  let cur = [];
  const n = samples.length;
  samples.forEach((v, i) => {
    if (Number.isFinite(v)) cur.push({ x: pc(n > 1 ? (i / (n - 1)) * 100 : 0), y: pc(100 - (Math.min(Math.max(v, 0), max) / max) * 100) });
    else { if (cur.length) out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}
function paths(samples, max, color) {
  const rs = runs(samples, max);
  const draw = rs.filter((r) => r.length > 1);
  if (!draw.length) return { els: [], rs };
  const area = PathBuilder.fill();
  const stroke = PathBuilder.stroke(1.3);
  for (const r of draw) {
    area.move_to(r[0].x, "100%");
    r.forEach((p, i) => { area.line_to(p.x, p.y); i ? stroke.line_to(p.x, p.y) : stroke.move_to(p.x, p.y); });
    area.line_to(r[r.length - 1].x, "100%").close();
  }
  // paint_path is a global of the mod runtime (herdwatch does the same); it is not exported by "herdr".
  return {
    rs,
    els: [window.paint_path(area.build(), Background.solid(color).opacity(0.16)).absolute().size_full(),
      window.paint_path(stroke.build(), color).absolute().size_full()],
  };
}

export function history(t, samples, color, { height = 70, max = 100 } = {}) {
  const chart = div().relative().w_full().h(height).flex_none().rounded(3).bg(t.canvas).overflow_hidden();
  [25, 50, 75].forEach((p) => chart.child(div().absolute().left(0).right(0).top(`${p}%`).h(1).bg(t.hover)));
  const { els, rs } = paths(samples, max, color);
  els.forEach((e) => chart.child(e));
  const last = rs.at(-1)?.at(-1);
  if (last && last.x === "100.00%") chart.child(div().absolute().right(0).top(last.y).w(4).h(4).mt(-2).rounded(2).bg(color));
  return chart;
}

export function sparkline(t, samples, color, { width = 120, height = 14, max = 100 } = {}) {
  const chart = div().relative().w(width).h(height).flex_none();
  paths(samples, max, color).els.forEach((e) => chart.child(e));
  return chart;
}

export const chip = (t, name, health) => h_flex().flex_none().h(20).px(8).gap(5).items_center().rounded(10).border(1).border_color(t.border)
  .text_size(11).text_color(t.muted)
  .child(dot(t, health === "ok" ? t.ansi2 : health === "error" ? t.ansi1 : t.dim, 6)).child(name);

// options: [label]; selected: index; onSelect(index, cx).
export function segmented(t, { id, options, selected, onSelect }) {
  return h_flex().id(id).h(22).p(2).gap(2).items_center().rounded(5).border(1).border_color(t.border).bg(t.canvas)
    .children(options.map((label, i) => h_flex().id(`${id}-${i}`).h(18).px(9).items_center().rounded(3).text_size(11).font_semibold()
      .cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onSelect(i, cx))
      .when(i === selected, (el) => el.bg(t.ansi4).text_color(t.background))
      .when(i !== selected, (el) => el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .child(label)));
}

// Right-aligned mono cell.
export const num = (t, text, color = t.foreground, width) => {
  const el = div().flex_none().text_right().text_color(color);
  return (width ? el.w(width) : el).child(String(text));
};

// Five 6px pips FIRE..PASS. dropped: all dim. Reached = the current stage or
// any stage the task ever reached (`stages`, the task's history, as the Pass does).
export function rail(t, stage, color, stages) {
  const reached = Math.max(0, STAGES.indexOf(stage), ...STAGES.map((s, i) => (stages?.[s] ? i : -1)));
  return h_flex().flex_none().gap(3).items_center().tooltip(STAGES.join(" · ").toUpperCase())
    .children(STAGES.map((_, i) =>
      stage === "dropped" ? dot(t, t.dim, 6).opacity(0.5)
        : i <= reached ? dot(t, color, 6)
        : dot(t, null, 6).border(1).border_color(t.border).bg(t.background)));
}

// The provider's icon (as the Pass's glyph); null when there is none.
export function glyph(t, program, size = 12) {
  if (!program?.icon) return null;
  return program.tint
    ? svg(program.icon).size(size).flex_none().text_color(t.muted)
    : image(program.icon).w(size).h(size).flex_none();
}

// columns: [{label, w (px; omit to share the rest), align: "right"}]. rows: [{key, cells:
// [string | element], under: element | null, onClick}].
export function table(t, columns, rows, selectedKey) {
  const al = (c, el) => (c.align === "right" ? el.text_right() : el);
  const cell = (c, content) => {
    const el = al(c, div().min_w(0).truncate().text_color(t.foreground));
    (c.w ? el.w(c.w).flex_none() : el.flex_1()).child(content ?? "");
    return el;
  };
  const head = h_flex().h(20).px(10).gap(8).items_center().children(columns.map((c) => {
    const el = al(c, div().min_w(0).truncate().text_size(10).text_color(t.dim)).child(c.label);
    return c.w ? el.w(c.w).flex_none() : el.flex_1();
  }));
  return v_flex().child(head).children(rows.map((r) => {
    const line = h_flex().id(`row-${r.key}`).h(24).px(10).gap(8).items_center()
      .when(r.key === selectedKey, (el) => el.bg(t.hover))
      .when(Boolean(r.onClick), (el) => el.cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(r.onClick))
      .children(columns.map((c, i) => cell(c, r.cells[i])));
    return r.under ? v_flex().child(line).child(r.under) : line;
  }));
}

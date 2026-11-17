// Deck's shared components. Every function takes the theme `t` first; colors
// come only from its tokens.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

export const STAGES = ["fire", "cook", "taste", "review", "pass"];

export const dot = (t, color, size = 7) => div().w(size).h(size).rounded(size / 2).flex_none().bg(color ?? t.border);

// A bordered box with the title inset at the top-left and a summary at the top-right.
export function box(t, title, right, children) {
  return v_flex().flex_none().rounded(6).border(1).border_color(t.border).mx(12).mt(12).pb(4)
    .child(
      h_flex().px(10).h(26).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().text_size(12).text_color(t.foreground).child(title))
        .child(div().flex_1())
        .child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(right ?? "")),
    )
    .children(children);
}

// Five 6px pips FIRE..PASS. dropped: all dim; sent_back: reached pips in `color`
// up to REVIEW (the board keeps no stage history here).
export function rail(t, stage, color) {
  const reached = stage === "dropped" ? -1 : stage === "sent_back" ? 3 : STAGES.indexOf(stage);
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

// columns: [{label, w (px; omit to share the rest), mono}]. rows: [{key, cells:
// [string | element], color (a cell's text color), under: element | null, onClick}].
export function table(t, columns, rows, selectedKey, mono) {
  const cell = (c, content, color) => {
    const el = div().min_w(0).truncate().text_size(11.5).text_color(color ?? t.foreground);
    if (c.mono) el.font_family(mono).text_size(11);
    (c.w ? el.w(c.w).flex_none() : el.flex_1()).child(content ?? "");
    return el;
  };
  const head = h_flex().h(20).px(10).gap(8).items_center().children(columns.map((c) => {
    const el = div().min_w(0).truncate().text_size(10).text_color(t.dim).child(c.label);
    return c.w ? el.w(c.w).flex_none() : el.flex_1();
  }));
  return v_flex().child(head).children(rows.map((r) => {
    const line = h_flex().id(`row-${r.key}`).h(24).px(10).gap(8).items_center()
      .when(r.key === selectedKey, (el) => el.bg(t.hover))
      .when(Boolean(r.onClick), (el) => el.cursor_pointer().on_click(r.onClick))
      .children(columns.map((c, i) => cell(c, r.cells[i], c.colorCell ? r.color : null)));
    return r.under ? v_flex().child(line).child(r.under) : line;
  }));
}

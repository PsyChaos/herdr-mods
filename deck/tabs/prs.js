// Deck's prs tab: a stub until its task lands (see RECIPE.md).
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { panel } from "../ui.js";

export default {
  id: "prs",
  label: "prs",
  icon: "git-pull-request",
  async load() { return { state: null, machines: {} }; },
  count: () => 0,
  blocked: () => false,
  rows: () => [],
  view(_state, _sel, _cx, _pick, { t }) {
    return v_flex().id("prs-body").flex_1().min_h(0)
      .child(panel(t, { id: "prs", icon: "git-pull-request", title: "prs", body: div().text_color(t.dim).child("Coming.") }));
  },
};

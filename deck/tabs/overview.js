// Stub until the overview tab lands (see docs/designs/deck-look.md).
import { v_flex } from "gpui-base";
import { panel } from "../ui.js";

export default {
  id: "overview",
  label: "overview",
  icon: "gauge",
  async load() { return { state: null, machines: {} }; },
  count: () => 0,
  blocked: () => false,
  rows: () => [],
  view(_state, _sel, _cx, _pick, { t }) {
    return v_flex().flex_1().child(panel(t, { id: "overview-soon", icon: "gauge", title: "overview", right: "coming", body: [] }));
  },
};

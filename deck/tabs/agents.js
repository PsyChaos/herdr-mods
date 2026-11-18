// Stub until the agents tab lands (see docs/designs/deck-look.md).
import { v_flex } from "gpui-base";
import { panel } from "../ui.js";

export default {
  id: "agents",
  label: "agents",
  icon: "bot",
  async load() { return { state: null, machines: {} }; },
  count: () => 0,
  blocked: () => false,
  rows: () => [],
  view(_state, _sel, _cx, _pick, { t }) {
    return v_flex().flex_1().child(panel(t, { id: "agents-soon", icon: "bot", title: "agents", right: "coming", body: [] }));
  },
};

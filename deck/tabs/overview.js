// Deck's Overview tab: one panel per machine with cores, cpu, memory, disk,
// network and agents, read from the shared probe (ctx.probe, see probe.js).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces } from "herdr";
import { panel, rowLabel, meter, coreCells, history, sparkline, band } from "../ui.js";

const names = (probe) => Object.keys(probe ?? {}).sort((a, b) => (a === "here" ? -1 : b === "here" ? 1 : a.localeCompare(b)));
const gib = (kib) => (kib / 1048576).toFixed(1);
const rate = (bps) => (bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`);
const upText = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : `${Math.max(0, Math.floor(s / 60))}m`);
const peak = (a, b) => Math.max(1, ...a.filter(Number.isFinite), ...b.filter(Number.isFinite));

// "3 working · 1 needs you · 2 idle" for the agents of one machine ("here" = this computer).
function agentText(name) {
  const where = new Map(spaces().map((s) => [s.space, s.machine ?? "here"]));
  const n = { working: 0, blocked: 0, done: 0, idle: 0 };
  for (const a of agents()) if ((where.get(a.space) ?? "here") === name && a.status in n) n[a.status]++;
  const parts = [[n.working, "working"], [n.blocked, "needs you"], [n.done, "done"], [n.idle, "idle"]].filter(([c]) => c).map(([c, w]) => `${c} ${w}`);
  return parts.join(" · ") || "none";
}

export default {
  id: "overview",
  label: "overview",
  icon: "gauge",
  async load() { return { state: null, machines: {} }; },
  count: (_state, probe) => names(probe).filter((m) => probe[m].ok).length,
  blocked: () => false,
  rows: (_state, probe) => names(probe).map((m) => ({ key: m, target: { tab: "agents" } })),

  view(_state, sel, _cx, pick, { range, probe, t }) {
    const bold = (text, color = t.foreground) => div().font_semibold().text_color(color).child(text);
    const line = (...kids) => h_flex().gap(8).items_center().children(kids);
    const slice = (h) => (h ?? []).slice(-range);
    const row = (iconName, word, body) => h_flex().gap(0).items_start().child(rowLabel(t, iconName, word)).child(v_flex().flex_1().min_w(0).gap(6).children(body));

    const card = (name) => {
      const m = probe[name];
      const s = m.sample;
      const title = { id: `machine-${name}`, icon: "server", title: name };
      if (!m.ok && !s) {
        return panel(t, { ...title, accent: t.ansi1, body: div().text_color(t.ansi1).child(m.error ?? "no data") });
      }
      const cpu = s.cpu, mem = s.mem, hist = m.history;
      const rx = slice(hist.rx), tx = slice(hist.tx), top = peak(rx, tx);
      const pct = (v, g) => bold(Number.isFinite(v) ? `${Math.round(v)}%` : "-", Number.isFinite(v) ? band(t, g, v) : t.dim);
      const body = [
        !m.ok && div().text_color(t.ansi1).child(m.error ?? "probe failed"),
        row("microchip", "cores", [coreCells(t, s.cores)]),
        row("cpu", "cpu", [
          meter(t, cpu, 24, "cpu"),
          line(pct(cpu, "cpu"), div().text_color(t.dim).child(`${s.cores.length} cores`)),
          history(t, slice(hist.cpu), t.ansi2),
        ]),
        row("memory-stick", "mem", [
          meter(t, mem.pct, 24, "mem"),
          line(pct(mem.pct, "mem"), div().text_color(t.dim).child(`${gib(mem.usedKiB)} / ${gib(mem.totalKiB)} GiB · swap ${Math.round(mem.swapPct)}%`)),
          history(t, slice(hist.mem), t.ansi6),
        ]),
        row("hard-drive", "disk", [
          meter(t, s.disk.pct, 24, "disk"),
          line(pct(s.disk.pct, "disk"), div().text_color(t.dim).child(`${gib(s.disk.freeKiB)} GiB free`)),
        ]),
        row("arrow-down-up", "net", [
          h_flex().gap(8).items_center()
            .child(sparkline(t, rx, t.ansi6, { max: top })).child(sparkline(t, tx, t.ansi4, { max: top }))
            .child(div().text_color(t.dim).child(s.net ? `↓ ${rate(s.net.rxBps)} ↑ ${rate(s.net.txBps)}` : "-")),
        ]),
        row("bot", "agents", [div().text_color(t.muted).child(agentText(name))]),
      ];
      return panel(t, { ...title, right: `linux · up ${upText(s.up)}`, body });
    };

    return v_flex().id("overview-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar()
      .children(names(probe).map((name) => div().id(`row-${name}`).cursor_pointer().when(name === sel, (el) => el.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => pick(name, cx)).child(card(name))));
  },
};

// Deck's Overview tab: one panel per machine with cores, cpu, memory, disk,
// network and agents, read from the shared probe (ctx.probe, see probe.js).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, exec } from "herdr";
import { panel, rowLabel, meter, coreCells, history, sparkline, band, table, textButton, dot, num } from "../ui.js";
import { EXTRAS, size, percent, parseExtras, dockerCounts } from "../machines-model.js";
import docker from "./docker.js";

// Machines' extras (processes, swap, disks, docker) come from their own exec
// every 10 s, never inside the shared 3 s probe. A slow read runs in the
// background; load returns the cache at once.
const EXTRAS_MS = 10000;
const extras = new Map(); // machine ("here" or its name) -> {data, error, at, busy}

function askExtras(machine) {
  const key = machine ?? "here";
  const cur = extras.get(key);
  if (cur?.busy || (cur && Date.now() - cur.at < EXTRAS_MS)) return;
  extras.set(key, { ...cur, busy: true, at: cur?.at ?? 0 });
  exec("python3", ["-I", "-c", EXTRAS], { ...(machine ? { on: machine } : {}), timeout: 8000 })
    .then((r) => {
      let data = cur?.data ?? null, error = null;
      try {
        if (r.code !== 0) throw new Error(r.stderr?.trim() || "no answer");
        data = parseExtras(r.stdout);
      } catch (e) { error = String(e?.message ?? e).split("\n").pop(); }
      extras.set(key, { data, error, at: Date.now(), reached: true });
    })
    .catch((e) => extras.set(key, { data: cur?.data ?? null, error: String(e?.message ?? e), at: Date.now(), reached: false }));
}

const names = (probe) => Object.keys(probe ?? {}).sort((a, b) => (a === "here" ? -1 : b === "here" ? 1 : a.localeCompare(b)));
const gib = (kib) => (kib / 1048576).toFixed(1);
const rate = (bps) => (bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`);
const upText = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : `${Math.max(0, Math.floor(s / 60))}m`);
const peak = (a, b) => Math.max(1, ...a.filter(Number.isFinite), ...b.filter(Number.isFinite));

// "3 working · 1 needs you · 2 idle" for the agents of one machine ("here" = this computer).
function agentText(name) {
  const where = new Map(spaces().map((s) => [s.id, s.machine ?? "here"]));
  const n = { working: 0, blocked: 0, done: 0, idle: 0 };
  for (const a of agents()) if ((where.get(a.space) ?? "here") === name && a.status in n) n[a.status]++;
  const parts = [[n.working, "working"], [n.blocked, "needs you"], [n.done, "done"], [n.idle, "idle"]].filter(([c]) => c).map(([c, w]) => `${c} ${w}`);
  return parts.join(" · ") || "none";
}

export default {
  id: "overview",
  label: "overview",
  icon: "gauge",
  async load({ machines }) {
    for (const m of machines) askExtras(m);
    // Only an exec that rejected means the machine cannot be reached.
    return { state: null, machines: Object.fromEntries(machines.map((m) => [m ?? "here", extras.get(m ?? "here")?.reached === false ? "error" : "ok"])) };
  },
  count: (_state, probe) => names(probe).filter((m) => probe[m].ok).length,
  blocked: () => false,
  // "docker:<name>" rows exist so "Open in Docker" can switch tabs through pick().
  rows: (_state, probe) => names(probe).flatMap((m) => [{ key: m, target: { tab: "agents" } },
    ...(dockerCounts(extras.get(m)?.data?.docker).length ? [{ key: `docker:${m}`, target: { tab: "docker" } }] : [])]),

  view(_state, sel, _cx, pick, { range, probe, t }) {
    const bold = (text, color = t.foreground) => div().font_semibold().text_color(color).child(text);
    const line = (...kids) => h_flex().gap(8).items_center().children(kids);
    const slice = (h) => (h ?? []).slice(-range);
    const row = (iconName, word, body) => h_flex().gap(0).items_start().child(rowLabel(t, iconName, word)).child(v_flex().flex_1().min_w(0).gap(6).children(body));

    const card = (name) => {
      const m = probe[name];
      const s = m.sample;
      const title = { id: `machine-${name}`, icon: "server", title: name };
      if (!m.ok || !s) {
        return panel(t, { ...title, accent: t.ansi1, body: div().text_color(t.ansi1).child(m.error ?? "no data") });
      }
      const cpu = s.cpu, mem = s.mem, hist = m.history;
      const rx = slice(hist.rx), tx = slice(hist.tx), top = peak(rx, tx);
      const pct = (v, g) => bold(Number.isFinite(v) ? `${Math.round(v)}%` : "-", Number.isFinite(v) ? band(t, g, v) : t.dim);
      const x = extras.get(name)?.data;
      const diskRows = x?.disks.length ? x.disks : null;
      const counts = dockerCounts(x?.docker);
      const bad = counts.some((c) => c.bad);
      const running = counts.some((c) => c.word === "running");
      const body = [
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
        ...(x?.swap.total > 0 ? [row("memory-stick", "swap", [
          meter(t, percent(x.swap.used, x.swap.total), 24, "mem"),
          line(pct(percent(x.swap.used, x.swap.total), "mem"), div().text_color(t.dim).child(`${size(x.swap.used)} of ${size(x.swap.total)}`)),
        ])] : []),
        ...(diskRows ?? [{ path: "/", total: s.disk.totalKiB * 1024, used: (s.disk.totalKiB - s.disk.freeKiB) * 1024 }]).map((d) => row("hard-drive", d.path === "/" ? "disk /" : `disk ${d.path}`, [
          meter(t, percent(d.used, d.total), 24, "disk"),
          line(pct(percent(d.used, d.total), "disk"), div().text_color(t.dim).child(`${size(d.total - d.used)} free of ${size(d.total)}`)),
        ])),
        row("arrow-down-up", "net", [
          h_flex().gap(8).items_center()
            .child(sparkline(t, rx, t.ansi6, { max: top })).child(sparkline(t, tx, t.ansi4, { max: top }))
            .child(div().text_color(t.dim).child(s.net ? `↓ ${rate(s.net.rxBps)} ↑ ${rate(s.net.txBps)}` : "-")),
        ]),
        ...(x?.top.length ? [row("activity", "procs", [table(t, [{ label: "name" }, { label: "cpu", w: 60, align: "right" }, { label: "mem", w: 70, align: "right" }],
          x.top.map((p, i) => ({ key: `${name}-proc-${i}`, cells: [p.name, num(t, `${p.cpu}%`, band(t, "cpu", p.cpu / 2)), num(t, size(p.rss), t.muted)] })))])] : []),
        ...(counts.length ? [row("container", "docker", [line(
          dot(t, bad ? t.blocked : running ? t.ansi2 : t.dim),
          div().flex_1().min_w(0).truncate().text_color(bad ? t.blocked : t.foreground).child(counts.map((c) => `${c.count} ${c.word}`).join(" · ")),
          textButton(t, { id: `docker-${name}`, label: "Open in Docker", onPress: (cx) => {
            if (docker.ui) docker.ui.query = name === "here" ? "This computer" : name; // the docker tab searches by machine label
            pick(`docker:${name}`, cx);
          } }))])] : []),
        row("bot", "agents", [div().text_color(t.muted).child(agentText(name))]),
        ...(extras.get(name)?.error ? [div().text_color(t.ansi3).child(`extras: ${extras.get(name).error}`)] : []),
      ];
      return panel(t, { ...title, right: `linux · up ${upText(s.up)}`, body });
    };

    return v_flex().id("overview-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar()
      .children(names(probe).map((name) => div().id(`row-${name}`).cursor_pointer().when(name === sel, (el) => el.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => pick(name, cx)).child(card(name))));
  },
};

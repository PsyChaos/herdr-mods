// Machines: how busy this computer and every connected Herdr machine are (CPU,
// memory, swap, disks, the busiest processes) and their Docker containers by
// compose project, with logs, start, stop and restart.
//
// Each machine runs one Python script (PROBE) every 10 seconds: /proc for CPU
// (two samples half a second apart), memory and per-process CPU, statvfs for
// disks, then `docker ps -a` and `docker stats --no-stream` (after the CPU
// sample, since docker stats keeps dockerd busy). Stop and restart ask first.
// Runs as a window: ctrl-shift-m ("mod.open:machines").

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, exec, hc, theme, props, closeOverlay, settings } from "herdr";

const REFRESH_MS = 10000;
const LOG_LINES = 120;
const WARN_PERCENT = 75;
const FULL_PERCENT = 90;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const PROBE = String.raw`
import json, os, subprocess, time

HOME = os.path.expanduser("~")
SAMPLE_S = 0.5

def run(argv, timeout=8):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:
        return 1, "", str(e)

def cpu_times():
    parts = open("/proc/stat").readline().split()[1:]
    values = [int(x) for x in parts]
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return sum(values), idle

def proc_ticks():
    out = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            stat = open(f"/proc/{pid}/stat").read()
            rest = stat[stat.rindex(")") + 2:].split()
            out[int(pid)] = (int(rest[11]) + int(rest[12]), stat[stat.index("(") + 1:stat.rindex(")")], int(rest[21]))
        except (OSError, ValueError, IndexError):
            pass
    return out

def meminfo():
    info = {}
    for line in open("/proc/meminfo"):
        key, value = line.split(":", 1)
        info[key] = int(value.split()[0]) * 1024
    return info

def disks():
    seen, out = set(), []
    for path in ["/", HOME, "/var/lib/docker"]:
        try:
            st = os.statvfs(path)
        except OSError:
            continue
        # Subvolumes of one filesystem have their own st_dev but the same size.
        dev = (st.f_blocks, st.f_frsize, st.f_files)
        if dev in seen:
            continue
        seen.add(dev)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        out.append({"path": "~" if path == HOME else path, "total": total, "used": total - free})
    return out

docker = {"containers": None, "stats": {}}

def docker_list():
    fmt = '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}'
    code, out, _ = run(["docker", "ps", "-a", "--format", fmt])
    if code != 0:
        return
    rows = []
    for line in out.splitlines():
        name, state, status, image, project, folder = (line.split("\t") + [""] * 6)[:6]
        if folder.startswith(HOME):
            folder = "~" + folder[len(HOME):]
        rows.append({"name": name, "state": state, "status": status, "image": image, "project": project or None, "folder": folder or None})
    docker["containers"] = rows
    code, out, _ = run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"], timeout=10)
    if code == 0:
        for line in out.splitlines():
            name, cpu, mem = (line.split("\t") + ["", ""])[:3]
            try:
                docker["stats"][name] = {"cpu": float(cpu.rstrip("%") or 0), "mem": mem.split(" / ")[0]}
            except ValueError:
                pass

t0, i0 = cpu_times()
p0 = proc_ticks()
time.sleep(SAMPLE_S)
t1, i1 = cpu_times()
p1 = proc_ticks()
cores = os.cpu_count() or 1
hz = os.sysconf("SC_CLK_TCK")
page = os.sysconf("SC_PAGE_SIZE")

top = []
me = os.getpid()
for pid, (ticks, name, rss) in p1.items():
    before = p0.get(pid)
    if not before or pid == me:
        continue
    pct = (ticks - before[0]) / hz / SAMPLE_S * 100
    if pct > 0.5:
        top.append({"pid": pid, "name": name, "cpu": round(pct, 1), "rss": rss * page})
top.sort(key=lambda p: -p["cpu"])
for p in top[:6]:
    try:
        argv = [a.decode(errors="replace") for a in open(f"/proc/{p['pid']}/cmdline", "rb").read().split(b"\0") if a]
        cmd = " ".join(argv)
        p["command"] = ("~" + cmd[len(HOME):] if cmd.startswith(HOME) else cmd)[:140]
    except OSError:
        pass

mem = meminfo()
# After the CPU sample: docker stats itself keeps dockerd busy.
docker_list()
print(json.dumps({
    "cpu": round(100 * (1 - (i1 - i0) / max(1, t1 - t0)), 1),
    "cores": cores,
    "load": os.getloadavg(),
    "uptime": float(open("/proc/uptime").read().split()[0]),
    "mem": {"total": mem["MemTotal"], "used": mem["MemTotal"] - mem.get("MemAvailable", mem["MemFree"])},
    "swap": {"total": mem.get("SwapTotal", 0), "used": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)},
    "disks": disks(),
    "top": top[:6],
    "docker": docker["containers"],
    "stats": docker["stats"],
}))
`;

const machineLabel = (name) => name ?? "This computer";

function size(bytes) {
  if (bytes >= 100 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

function since(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const percent = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

// running, exited, paused, restarting, created, dead; unhealthy wins over running.
function containerState(c) {
  if (/\(unhealthy\)/.test(c.status)) return "unhealthy";
  if (c.state === "running") return /\(health: starting\)/.test(c.status) ? "starting" : "running";
  if (c.state === "restarting") return "restarting";
  if (c.state === "exited" && /Exited \((?!0\))/.test(c.status)) return "failed";
  return c.state;
}

export default class Machines extends View {
  init(_props, cx) {
    this.results = {};
    this.open = new Set();
    this.confirming = null;
    this.notes = {};
    this.logs = null;
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  targets() {
    return [null, ...machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name)];
  }

  run(machine, argv) {
    return machine
      ? hc(["exec", "--on", machine, "--", ...argv]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }))
      : exec(argv[0], argv.slice(1)).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  }

  refresh(cx) {
    for (const machine of this.targets()) {
      const key = machineLabel(machine);
      const current = this.results[key];
      if (current?.loading) continue;
      this.results[key] = { ...(current ?? {}), machine, loading: true };
      cx.spawn(async (cx) => {
        const answer = await this.run(machine, ["python3", "-I", "-c", PROBE]);
        let data = current?.data ?? null;
        let error = null;
        try {
          if (answer.code !== 0) throw new Error(answer.stderr?.trim() || "no answer");
          data = JSON.parse(answer.stdout);
        } catch (e) {
          error = `Couldn't read it: ${String(e?.message ?? e).split("\n").pop()}`;
        }
        this.results[key] = { machine, data, error, loading: false, at: Date.now() };
        cx.notify();
      });
    }
    cx.notify();
  }

  // docker start / stop / restart <name> on the container's machine.
  docker(machine, c, action, cx) {
    const key = `${machineLabel(machine)}|${c.name}`;
    this.confirming = null;
    this.notes[key] = { text: `${action}ing…`, error: false };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.run(machine, ["docker", action, c.name]);
      if (r.code === 0) delete this.notes[key];
      else this.notes[key] = { text: `${action} failed: ${(r.stderr || "").trim().split("\n").pop()}`, error: true };
      this.refresh(cx);
    });
  }

  showLogs(machine, c, cx) {
    this.logs = { machine, name: c.name, lines: [], loading: true, error: null };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.run(machine, ["sh", "-c", 'docker logs --tail "$1" "$2" 2>&1', "sh", String(LOG_LINES), c.name]);
      if (this.logs?.name !== c.name || this.logs?.machine !== machine) return;
      const lines = (r.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      this.logs = { ...this.logs, loading: false, lines,
        error: r.code !== 0 ? (lines.pop() || "docker couldn't read the logs.") : lines.length ? null : "No log output." };
      cx.notify();
    });
  }

  colorOf(t, pct) {
    if (pct >= FULL_PERCENT) return t.blocked;
    if (pct >= WARN_PERCENT) return t.ansi3 ?? t.working;
    return t.accent;
  }

  stateColor(t, state) {
    return { running: t.ansi2 ?? t.done, starting: t.ansi3, restarting: t.ansi3, unhealthy: t.blocked, failed: t.blocked, paused: t.ansi3 }[state] ?? t.dim;
  }

  button(t, id, label, onClick, danger) {
    return div()
      .id(id)
      .px(6)
      .py(1)
      .rounded(5)
      .flex_none()
      .text_size(11)
      .text_color(danger ? t.blocked : t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground))
      // A press that isn't stopped drags the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  // "CPU   ▬▬▬▬──────  31%   load 1.0 · 8 cores"
  meter(t, id, label, pct, text) {
    const shown = Math.max(0, Math.min(100, pct));
    const color = this.colorOf(t, shown);
    return h_flex()
      .id(id)
      .gap(8)
      .items_center()
      .text_size(11)
      .child(div().w(52).flex_none().truncate().text_color(t.muted).child(label))
      .child(h_flex().flex_1().min_w(0).h(5).rounded(3).bg(t.input).overflow_hidden()
        .child(div().h(5).rounded(3).bg(color).flex_grow(shown))
        .child(div().h(5).flex_grow(100 - shown)))
      .child(div().w(38).flex_none().text_color(shown >= WARN_PERCENT ? color : t.foreground).child(`${Math.round(pct)}%`))
      .child(div().w(150).flex_none().truncate().text_size(10).text_color(t.dim).child(text));
  }

  header(t) {
    const overlay = props()?.overlay;
    return h_flex()
      .h(32)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .text_size(12)
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Machines"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child("load, memory, disks and containers · every 10 s"))
      .child(this.button(t, "refresh", "↻", (_e, cx) => this.refresh(cx)))
      .when(Boolean(overlay), (el) => el.child(this.button(t, "close", "✕", () => closeOverlay(overlay))));
  }

  machineCard(t, result) {
    const name = machineLabel(result.machine);
    const d = result.data;
    // A band on raised, as the PRs & CI window shows spaces.
    const band = h_flex().mt(8).px(10).py(4).gap(6).items_center().bg(t.raised ?? t.hover)
      .child(div().flex_none().font_semibold().text_size(12.5).text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(result.error ? t.blocked : t.dim)
        .child(result.error ?? (d ? `up ${since(d.uptime)} · ${d.cores} cores` : "reading…")));
    const rows = [];
    if (!d) return band;
    const id = (x) => `${name}-${x}`;
    rows.push(this.meter(t, id("cpu"), "CPU", d.cpu, `load ${d.load.map((x) => x.toFixed(1)).join(" ")}`));
    rows.push(this.meter(t, id("mem"), "Memory", percent(d.mem.used, d.mem.total), `${size(d.mem.used)} of ${size(d.mem.total)}`));
    if (d.swap.total > 0) rows.push(this.meter(t, id("swap"), "Swap", percent(d.swap.used, d.swap.total), `${size(d.swap.used)} of ${size(d.swap.total)}`));
    for (const disk of d.disks) {
      rows.push(this.meter(t, id(`disk${disk.path}`), `Disk ${disk.path}`, percent(disk.used, disk.total), `${size(disk.total - disk.used)} free of ${size(disk.total)}`));
    }
    if (d.top.length) {
      rows.push(div().pt(6).pb(1).text_size(10).text_color(t.dim).child("Busiest now"));
      rows.push(...d.top.slice(0, 5).map((p) => h_flex().gap(8).items_center().text_size(11)
        .child(div().w(52).flex_none().text_color(this.colorOf(t, p.cpu / 2)).child(`${p.cpu}%`))
        .child(div().w(110).flex_none().truncate().text_color(t.foreground).child(p.name))
        .child(div().w(60).flex_none().text_size(10).text_color(t.muted).child(size(p.rss)))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(p.command ?? ""))));
    }
    return v_flex().child(band).child(v_flex().px(10).pt(6).pb(4).gap(3).children(rows));
  }

  // A compose project as one line; open, its containers under it.
  projectRows(t, machine, project, list, stats) {
    const key = `${machineLabel(machine)}|${project ?? "-"}`;
    const counts = {};
    for (const c of list) {
      const s = containerState(c);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const bad = (counts.unhealthy ?? 0) + (counts.failed ?? 0) + (counts.restarting ?? 0);
    // A project with trouble opens by itself until you close it.
    const open = this.open.has(key) || (bad > 0 && !this.open.has(`closed:${key}`));
    const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ");
    const worst = bad ? t.blocked : counts.running ? (t.ansi2 ?? t.done) : t.dim;
    const line = h_flex().id(`project-${key}`).px(10).py(3).gap(8).items_center().cursor_pointer()
      .text_size(11.5).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        if (open) { this.open.delete(key); this.open.add(`closed:${key}`); } else { this.open.add(key); this.open.delete(`closed:${key}`); }
        cx.notify();
      })
      .child(div().w(10).flex_none().text_color(t.dim).child(open ? "▾" : "▸"))
      .child(div().flex_none().w(7).h(7).rounded(4).bg(worst))
      .child(div().flex_none().font_medium().text_color(t.foreground).child(project ?? "other containers"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(bad ? t.blocked : t.dim)
        .child([summary, list[0]?.folder].filter(Boolean).join(" · ")));
    if (!open) return [line];
    return [line, ...list.flatMap((c) => this.containerRows(t, machine, project, c, stats[c.name]))];
  }

  containerRows(t, machine, project, c, stat) {
    const key = `${machineLabel(machine)}|${c.name}`;
    const state = containerState(c);
    const running = c.state === "running" || c.state === "restarting";
    const short = project && c.name.startsWith(`${project}-`) ? c.name.slice(project.length + 1) : c.name;
    const usage = stat && running ? `${stat.cpu.toFixed(1)}% · ${stat.mem}` : "";
    const row = h_flex().id(`c-${key}`).pl(36).pr(10).py(2).gap(8).items_center().text_size(11).hover((s) => s.bg(t.hover))
      .child(div().flex_none().w(7).h(7).rounded(4).bg(this.stateColor(t, state)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(running ? t.foreground : t.muted).child(short))
        .child(div().truncate().text_size(10).text_color(state === "unhealthy" || state === "failed" ? t.blocked : t.dim)
          .child([c.status, usage].filter(Boolean).join(" · "))))
      .child(this.button(t, `logs-${key}`, "Logs", (_e, cx) => this.showLogs(machine, c, cx)))
      .when(running, (el) => el
        .child(this.button(t, `restart-${key}`, "Restart", (_e, cx) => { this.confirming = { key, action: "restart" }; cx.notify(); }))
        .child(this.button(t, `stop-${key}`, "Stop", (_e, cx) => { this.confirming = { key, action: "stop" }; cx.notify(); }, true)))
      .when(!running, (el) => el.child(this.button(t, `start-${key}`, "Start", (_e, cx) => this.docker(machine, c, "start", cx))));
    const out = [row];
    if (this.confirming?.key === key) out.push(this.confirmRow(t, machine, c, this.confirming.action));
    const note = this.notes[key];
    if (note) out.push(div().pl(51).pb(2).text_size(10.5).text_color(note.error ? t.blocked : t.dim).child(note.text));
    return out;
  }

  confirmRow(t, machine, c, action) {
    const key = `${machineLabel(machine)}|${c.name}`;
    const why = action === "stop"
      ? "Whatever uses it (an app, its tests, an agent's dev server) loses it until it is started again."
      : "It goes away for a few seconds; connections to it drop.";
    return v_flex().ml(36).mr(10).mb(4).px(10).py(6).gap(5).rounded(7).border_1().border_color(t.blocked).text_size(11)
      .child(div().text_color(t.foreground).child(`${action === "stop" ? "Stop" : "Restart"} ${c.name} on ${machineLabel(machine)}?`))
      .child(div().text_size(10.5).text_color(t.dim).child(why))
      .child(h_flex().gap(6).justify_end()
        .child(this.button(t, `no-${key}`, "Cancel", (_e, cx) => { this.confirming = null; cx.notify(); }))
        .child(div().id(`yes-${key}`).px(8).py(1).rounded(5).flex_none().text_size(11).font_medium()
          .bg(t.blocked).text_color(t.background).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.docker(machine, c, action, cx))
          .child(action === "stop" ? "Stop" : "Restart")));
  }

  dockerSection(t, result) {
    const list = result.data?.docker;
    if (!list || !list.length) return [];
    const byProject = new Map();
    for (const c of list) {
      if (!byProject.has(c.project)) byProject.set(c.project, []);
      byProject.get(c.project).push(c);
    }
    const running = list.filter((c) => c.state === "running").length;
    const rows = [div().px(10).pt(6).pb(2).text_size(10).text_color(t.dim)
      .child(`Docker · ${running} of ${list.length} containers running`)];
    const ordered = [...byProject.keys()].sort((a, b) => (a === null) - (b === null) || String(a).localeCompare(String(b)));
    for (const project of ordered) rows.push(...this.projectRows(t, result.machine, project, byProject.get(project), result.data.stats ?? {}));
    return rows;
  }

  logPanel(t) {
    const logs = this.logs;
    const font = settings().font_family ?? "JetBrains Mono";
    return v_flex()
      .flex_none()
      .h(260)
      .border_t(1)
      .border_color(t.border)
      .child(h_flex().h(28).flex_none().px(10).gap(6).items_center().text_size(11)
        .child(div().flex_none().font_semibold().text_color(t.foreground).child("Logs"))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim)
          .child(`${logs.name} · ${machineLabel(logs.machine)} · last ${LOG_LINES} lines`))
        .child(this.button(t, "logs-close", "✕", (_e, cx) => { this.logs = null; cx.notify(); })))
      .child(v_flex().id("log-lines").flex_1().min_h(0).px(10).pb(6).overflow_y_scrollbar()
        .font_family(font).text_size(10.5).text_color(t.muted)
        .when(logs.loading, (el) => el.child(div().text_color(t.dim).child("reading the logs…")))
        .when(Boolean(logs.error), (el) => el.child(div().text_color(t.blocked).child(logs.error)))
        .children(logs.lines.map((l, i) => div().id(`l-${i}`).whitespace_nowrap().truncate()
          .text_color(/\b(error|fatal|panic|exception|fail(ed)?)\b/i.test(l) ? t.blocked : t.muted).child(l || " "))));
  }

  render(_props, cx) {
    const t = theme();
    const sections = [];
    for (const machine of this.targets()) {
      const result = this.results[machineLabel(machine)] ?? { machine, loading: true };
      sections.push(this.machineCard(t, { ...result, machine }));
      sections.push(...this.dockerSection(t, { ...result, machine }));
    }
    return v_flex()
      .id("machines")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.confirming) this.confirming = null;
        else if (this.logs) this.logs = null;
        else closeOverlay(props()?.overlay);
        cx.stop_propagation();
        cx.notify();
      })
      .size_full()
      .text_size(13)
      .child(this.header(t))
      .child(v_flex().id("machine-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(sections))
      .when(Boolean(this.logs), (el) => el.child(this.logPanel(t)))
      .child(div().flex_none().px(10).py(5).border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child("Projects with trouble open by themselves. Stop and Restart ask first."));
  }
}

// Machines: how busy this computer and every connected Herdr machine are (CPU,
// memory, swap, disks, the busiest processes) and how many Docker containers
// run there. The containers themselves are the docker mod's: "Open in Docker"
// opens it searching for that machine.
//
// Each machine runs one Python script (PROBE) every 10 seconds: /proc for CPU
// (two samples half a second apart), memory and per-process CPU, statvfs for
// disks, then `docker ps -a` for the container counts.
// Runs as a window: ctrl-shift-m ("mod.open:machines").

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, exec, hc, theme, props, closeOverlay, openOverlay, setShared } from "herdr";

const REFRESH_MS = 10000;
// Read by the docker mod when it opens (see docker/main.js).
const DOCKER_REQUEST = "docker.request";
// The docker mod's window as its mod.json describes it. openOverlay, not
// mod.open: mod.open toggles, so it would close a Docker window already open;
// opening the same key replaces it in its place.
const DOCKER_WINDOW = { mod: "docker", kind: "window", key: "docker", width: 620, height: 640 };
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

# Container states only: no docker stats, which keeps dockerd busy.
def docker_states():
    code, out, _ = run(["docker", "ps", "-a", "--format", "{{.State}}\t{{.Status}}"])
    if code != 0:
        return None
    return [dict(zip(("state", "status"), (line.split("\t") + [""])[:2])) for line in out.splitlines()]

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
print(json.dumps({
    "cpu": round(100 * (1 - (i1 - i0) / max(1, t1 - t0)), 1),
    "cores": cores,
    "load": os.getloadavg(),
    "uptime": float(open("/proc/uptime").read().split()[0]),
    "mem": {"total": mem["MemTotal"], "used": mem["MemTotal"] - mem.get("MemAvailable", mem["MemFree"])},
    "swap": {"total": mem.get("SwapTotal", 0), "used": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)},
    "disks": disks(),
    "top": top[:6],
    "docker": docker_states(),
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

  colorOf(t, pct) {
    if (pct >= FULL_PERCENT) return t.blocked;
    if (pct >= WARN_PERCENT) return t.ansi3 ?? t.working;
    return t.accent;
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .px(6)
      .py(1)
      .rounded(5)
      .flex_none()
      .text_size(11)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
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
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child("load, memory, disks · every 10 s"))
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

  // "Docker   7 running · 20 stopped · 1 unhealthy        Open in Docker"
  dockerLine(t, result) {
    const list = result.data?.docker;
    if (!list || !list.length) return null;
    const counts = {};
    for (const c of list) {
      const s = containerState(c);
      const group = s === "running" || s === "starting" ? "running" : s === "exited" || s === "created" ? "stopped" : s;
      counts[group] = (counts[group] ?? 0) + 1;
    }
    const order = ["running", "stopped", "unhealthy", "failed", "restarting", "paused", "dead"];
    const bad = (counts.unhealthy ?? 0) + (counts.failed ?? 0) + (counts.restarting ?? 0) + (counts.dead ?? 0);
    const text = order.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(" · ");
    const name = machineLabel(result.machine);
    return h_flex().px(10).pb(6).gap(8).items_center().text_size(11)
      .child(div().w(52).flex_none().text_color(t.muted).child("Docker"))
      .child(div().flex_none().w(7).h(7).rounded(4).bg(bad ? t.blocked : counts.running ? (t.ansi2 ?? t.done) : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(bad ? t.blocked : t.foreground).child(text))
      .child(this.button(t, `docker-${name}`, "Open in Docker", () => {
        setShared(DOCKER_REQUEST, { search: name, at: Date.now() });
        openOverlay(DOCKER_WINDOW);
      }));
  }

  render(_props, cx) {
    const t = theme();
    const sections = [];
    for (const machine of this.targets()) {
      const result = this.results[machineLabel(machine)] ?? { machine, loading: true };
      sections.push(this.machineCard(t, { ...result, machine }));
      const docker = this.dockerLine(t, { ...result, machine });
      if (docker) sections.push(docker);
    }
    return v_flex()
      .id("machines")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props()?.overlay);
        cx.stop_propagation();
      })
      .size_full()
      .text_size(13)
      .child(this.header(t))
      .child(v_flex().id("machine-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(sections))
      .child(div().flex_none().px(10).py(5).border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child("Colors: 75% and up warns, 90% and up is red. Containers: Open in Docker (Ctrl+Shift+S)."));
  }
}

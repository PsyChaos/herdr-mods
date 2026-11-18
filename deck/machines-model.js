// Pure part of Deck's Overview extras (from the old machines mod): the script
// each machine runs every 10 s and how its answer is read. Imports nothing
// from Herdr so node can test it.

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// Top processes, swap, disks and docker container states; the shared probe
// has the rest. Filesystems are told apart by size, not st_dev: btrfs
// subvolumes have their own device numbers on one filesystem.
export const EXTRAS = String.raw`
import json, os, subprocess, time

HOME = os.path.expanduser("~")
SAMPLE_S = 0.5

def run(argv, timeout=8):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except Exception:
        return 1, ""

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

def disks():
    seen, out = set(), []
    for path in ["/", HOME, "/var/lib/docker"]:
        try:
            st = os.statvfs(path)
        except OSError:
            continue
        dev = (st.f_blocks, st.f_frsize, st.f_files)
        if dev in seen:
            continue
        seen.add(dev)
        total = st.f_blocks * st.f_frsize
        out.append({"path": "~" if path == HOME else path, "total": total, "used": total - st.f_bavail * st.f_frsize})
    return out

def swap():
    info = {}
    for line in open("/proc/meminfo"):
        key, value = line.split(":", 1)
        if key in ("SwapTotal", "SwapFree"):
            info[key] = int(value.split()[0]) * 1024
    return {"total": info.get("SwapTotal", 0), "used": info.get("SwapTotal", 0) - info.get("SwapFree", 0)}

# Container states only: no docker stats, which keeps dockerd busy.
def docker_states():
    code, out = run(["timeout", "2", "docker", "ps", "-a", "--format", "{{.State}}\t{{.Status}}"])
    if code != 0:
        return None
    return [dict(zip(("state", "status"), (line.split("\t") + [""])[:2])) for line in out.splitlines()]

p0 = proc_ticks()
time.sleep(SAMPLE_S)
p1 = proc_ticks()
hz = os.sysconf("SC_CLK_TCK")
page = os.sysconf("SC_PAGE_SIZE")
me = os.getpid()
top = []
for pid, (ticks, name, rss) in p1.items():
    before = p0.get(pid)
    if not before or pid == me:
        continue
    pct = (ticks - before[0]) / hz / SAMPLE_S * 100
    if pct > 0.5:
        top.append({"name": name, "cpu": round(pct, 1), "rss": rss * page})
top.sort(key=lambda p: -p["cpu"])
print(json.dumps({"top": top[:6], "swap": swap(), "disks": disks(), "docker": docker_states()}))
`;

export function size(bytes) {
  if (bytes >= 100 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

export const percent = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

// The script's JSON, with missing parts empty. Throws on text that is not JSON.
export function parseExtras(text) {
  const d = JSON.parse(text);
  return { top: d.top ?? [], swap: d.swap ?? { total: 0, used: 0 }, disks: d.disks ?? [], docker: Array.isArray(d.docker) ? d.docker : null };
}

// running, exited, paused, restarting, created, dead; unhealthy wins over running.
export function containerState(c) {
  if (/\(unhealthy\)/.test(c.status)) return "unhealthy";
  if (c.state === "running") return /\(health: starting\)/.test(c.status) ? "starting" : "running";
  if (c.state === "restarting") return "restarting";
  if (c.state === "exited" && /Exited \((?!0\))/.test(c.status)) return "failed";
  return c.state;
}

const ORDER = ["running", "stopped", "unhealthy", "failed", "restarting", "paused", "dead"];

// [{word, count, bad}] in display order, e.g. 7 running, 20 stopped, 1 unhealthy.
export function dockerCounts(list) {
  const counts = {};
  for (const c of list ?? []) {
    const s = containerState(c);
    const group = s === "running" || s === "starting" ? "running" : s === "exited" || s === "created" ? "stopped" : s;
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return ORDER.filter((k) => counts[k]).map((word) => ({ word, count: counts[word], bad: ["unhealthy", "failed", "restarting", "dead"].includes(word) }));
}

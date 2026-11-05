// What the Docker window knows about each machine's containers, and how it
// groups, filters and searches them. No drawing here.

// One small Python script per machine: `docker ps -a` for every container, and
// `docker stats --no-stream` (in parallel, given up after STATS_TIMEOUT) for the
// running ones' CPU and memory. Prints {containers} or {missing} or {error}.
export const PROBE = String.raw`
import json, os, re, shutil, subprocess
HOME = os.path.expanduser("~")
STATS_TIMEOUT = 6

def short(path):
    return "~" + path[len(HOME):] if path and (path == HOME or path.startswith(HOME + "/")) else path

if not shutil.which("docker"):
    print(json.dumps({"missing": True}))
    raise SystemExit
stats = subprocess.Popen(["docker", "stats", "--no-stream", "--no-trunc", "--format", "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
fields = ["{{.ID}}", "{{.Names}}", "{{.Image}}", "{{.State}}", "{{.Status}}", "{{.Ports}}", "{{.RunningFor}}",
          '{{.Label "com.docker.compose.project"}}', '{{.Label "com.docker.compose.project.working_dir"}}',
          '{{.Label "com.docker.compose.service"}}']
try:
    ps = subprocess.run(["docker", "ps", "-a", "--no-trunc", "--format", "\t".join(fields)], capture_output=True, text=True, timeout=10)
except subprocess.TimeoutExpired:
    stats.kill()
    print(json.dumps({"error": "docker ps didn't answer in 10 s"}))
    raise SystemExit
if ps.returncode != 0:
    stats.kill()
    lines = (ps.stderr or ps.stdout).strip().splitlines()
    print(json.dumps({"error": lines[-1] if lines else f"docker ps failed (exit {ps.returncode})"}))
    raise SystemExit
try:
    usage = {}
    for line in stats.communicate(timeout=STATS_TIMEOUT)[0].splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            usage[parts[0]] = {"cpu": parts[1], "memory": parts[2].split(" / ")[0]}
except subprocess.TimeoutExpired:
    stats.kill()
    usage = {}
out = []
for line in ps.stdout.splitlines():
    parts = (line.split("\t") + [""] * 10)[:10]
    cid, name, image, state, status, ports, age, project, folder, service = parts
    published = []
    for host, inner in re.findall(r":(\d+)->(\d+)/", ports):
        item = host if host == inner else f"{host}->{inner}"
        if item not in published:
            published.append(item)
    health = re.search(r"\((healthy|unhealthy|health: starting)\)", status)
    out.append({"id": cid, "name": name, "image": image, "state": state, "status": status, "age": age,
                "ports": published, "project": project or None, "folder": short(folder) or None,
                "service": service or None, "health": health.group(1) if health else None,
                **usage.get(cid, {})})
print(json.dumps({"containers": out}))
`;

export const machineLabel = (name) => name ?? "This computer";

export const FILTERS = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "stopped", label: "Stopped" },
];

// "running" covers paused and restarting too: they hold their resources.
export const isUp = (c) => c.state === "running" || c.state === "paused" || c.state === "restarting";

export function passes(filter, c) {
  if (filter === "running") return isUp(c);
  if (filter === "stopped") return !isUp(c);
  return true;
}

// Every word must appear in the container's machine, project, folder, name,
// image, service, state, status or ports.
export function matches(machine, c, words) {
  if (!words.length) return true;
  const text = [machineLabel(machine), c.project, c.folder, c.name, c.image, c.service, c.state, c.status,
    ...c.ports.map((p) => `:${p}`)].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

// Compose projects (and "Other containers" for the rest), the ones with
// something running first, then by name; containers by name.
export function projects(containers) {
  const groups = new Map();
  for (const c of containers) {
    const key = c.project ?? "";
    if (!groups.has(key)) groups.set(key, { name: c.project, folder: c.folder, containers: [] });
    groups.get(key).containers.push(c);
  }
  const list = [...groups.values()].map((g) => ({
    ...g,
    containers: [...g.containers].sort((a, b) => a.name.localeCompare(b.name)),
    up: g.containers.filter(isUp).length,
  }));
  return list.sort((a, b) => (b.up > 0) - (a.up > 0) || (a.name === null) - (b.name === null)
    || (a.name ?? "").localeCompare(b.name ?? ""));
}

// The theme color for a container's state dot.
export function stateColor(t, c) {
  if (c.state === "running") return c.health === "unhealthy" ? t.blocked : c.health === "health: starting" ? t.working : t.done ?? t.accent;
  if (c.state === "restarting" || c.state === "paused") return t.working;
  if (c.state === "dead") return t.blocked;
  return t.dim;
}

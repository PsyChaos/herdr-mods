// Deck's Ports tab: which program or container listens on which TCP port, on
// this computer and every Herdr machine (ported from the ports mod). Data: one
// Python PROBE per machine every 10 s (`ss`, /proc, `docker ps`).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, panes, run, exec, hc, setShared } from "herdr";
import { panel, table, rowButton, chips, openUrl } from "../ui.js";
import { kindOf, isWeb, shown, machineLabel, portId, freeLocalPort, stopLines, pollUntil } from "../ports-model.js";

const REFRESH_MS = 10000;
const STOP_CHECK_MS = 2500;
const TUNNEL_LIFETIME = "12h";
const TUNNEL_WAIT_MS = 6000;
const POLL_MS = 250;
const LISTENING_SH = 'ss -ltnH "sport = :$1" | grep -q .';
// Signals process $1 only if it still listens on port $2 (a pid can be reused since the list was read).
const KILL_SH = 'ss -ltnpH "sport = :$2" | grep -q "pid=$1," || { echo "It no longer listens on :$2." >&2; exit 3; }; kill -s "$3" "$1"';

const PROBE = String.raw`
import json, os, re, subprocess
HOME = os.path.expanduser("~")

def run(argv):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=4).stdout
    except Exception:
        return ""

def short(path):
    if path and (path == HOME or path.startswith(HOME + "/")):
        return "~" + path[len(HOME):]
    return path

def proc(pid):
    info = {}
    try:
        argv = [a.decode(errors="replace") for a in open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0") if a]
        if argv:
            info["program"] = os.path.basename(argv[0]).split(" (")[0]
            info["command"] = short(" ".join(argv))[:160]
    except OSError:
        pass
    try:
        info["folder"] = short(os.readlink(f"/proc/{pid}/cwd"))
    except OSError:
        pass
    try:
        for var in open(f"/proc/{pid}/environ", "rb").read().split(b"\0"):
            if var.startswith(b"HC_TERMINAL_ID="):
                info["terminal"] = var.split(b"=", 1)[1].decode()
    except OSError:
        pass
    return info

containers = {}
fmt = '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}'
for line in run(["docker", "ps", "--format", fmt]).splitlines():
    name, ports, folder = (line.split("\t") + ["", ""])[:3]
    for port in re.findall(r":(\d+)->", ports):
        containers[int(port)] = {"container": name, "folder": short(folder) or None}

found = {}
for line in run(["ss", "-ltnpH"]).splitlines():
    parts = line.split()
    if len(parts) < 4:
        continue
    host, _, port = parts[3].rpartition(":")
    if not port.isdigit():
        continue
    entry = found.setdefault(int(port), {"port": int(port), "hosts": set()})
    entry["hosts"].add(host.strip("[]"))
    pid = re.search(r"pid=(\d+)", line)
    if pid and "program" not in entry:
        entry["pid"] = int(pid.group(1))
        entry.update(proc(int(pid.group(1))))
        name = re.search(r'users:\(\("([^"]+)"', line)
        entry.setdefault("program", name.group(1) if name else None)

out = []
for port, entry in sorted(found.items()):
    entry.update(containers.get(port, {}))
    hosts = sorted(entry.pop("hosts"))
    entry["local_only"] = all(h.startswith("127.") or h in ("::1", "localhost") for h in hosts)
    out.append(entry)
print(json.dumps(out))
`;

const slot = (machine) => machine ?? "here"; // key in load()'s machine report

// Module scope: survives a load in flight, a close and a reopen.
const results = {}; // label -> {machine, ports, error, loading, at}
const sshTargets = {};
let targetsAsked = false;
let showAll = false;
export const ui = { dialog: null, note: null };
const say = (cx, text, level = "info") => { ui.note = { text, level, at: Date.now() }; cx.notify(); };

const inMachine = (machine, argv) => (machine
  ? hc(["exec", "--on", machine, "--", ...argv])
  : exec(argv[0], argv.slice(1))).catch((e) => ({ code: 1, stderr: String(e), rejected: true }));

// Reads one machine; `unreachable` is set only when the exec itself failed.
async function read(machine) {
  const key = machineLabel(machine);
  const current = results[key];
  results[key] = { ...(current ?? {}), machine, loading: true };
  const answer = machine
    ? await hc(["exec", "--on", machine, "--", "python3", "-I", "-c", PROBE]).catch((e) => ({ code: 1, stderr: String(e), rejected: true }))
    : await exec("python3", ["-I", "-c", PROBE]).catch((e) => ({ code: 1, stderr: String(e), rejected: true }));
  let ports = current?.ports ?? [];
  let error = null;
  try {
    if (answer.code !== 0) throw new Error(answer.stderr?.trim() || "no answer");
    ports = JSON.parse(answer.stdout);
  } catch (e) {
    error = `Couldn't read ports: ${String(e?.message ?? e).split("\n")[0]}`;
  }
  results[key] = { machine, ports, error, loading: false, at: Date.now(), unreachable: Boolean(answer.rejected) };
}

// The Herdr terminal a port's program was started in, as terminals() names it.
function terminalOf(machine, p) {
  if (!p.terminal) return null;
  const address = machine ? `${machine}/${p.terminal}` : p.terminal;
  return terminals().find((t) => t.address === address && t.state === "live") ?? null;
}

// Live tunnels, by "machine:port": their terminal and the port here.
function tunnels() {
  const out = new Map();
  for (const term of terminals()) {
    if (term.state !== "live" || !term.labels?.tunnel) continue;
    out.set(term.labels.tunnel, { address: term.address, local: Number(term.labels.tunnel_local) });
  }
  return out;
}

const visible = (query) => Object.values(results).sort((a, b) => (a.machine ?? "").localeCompare(b.machine ?? ""))
  .map((r) => ({ ...r, list: shown(r.machine, r.ports ?? [], query, showAll, (p) => terminalOf(r.machine, p)) }));

function openPage(machine, p) {
  setShared("browser.request", { url: `localhost:${p.port}`, machine, at: Date.now() });
  run("mod.open", { name: "browser" });
}

function goTo(term) {
  if (panes().some((x) => x.terminal === term.address)) run("pane.focus", { terminal: term.address });
  else run("terminal.peek", { terminal: term.address });
}

async function closeTunnel(address) {
  await hc(["kill", address]).catch(() => null);
  await hc(["rm", address]).catch(() => null);
}

const listening = async (port) => (await exec("sh", ["-c", LISTENING_SH, "sh", String(port)]).catch(() => ({ code: 1 }))).code === 0;

// Another machine's port gets an ssh tunnel to a port here, run as a Herdr
// terminal labelled tunnel=<machine>:<port>, so it lasts and "Close tunnel" ends it.
function myBrowser(machine, p, cx) {
  if (!machine) return void openUrl(`http://localhost:${p.port}`);
  const open = tunnels().get(`${machine}:${p.port}`);
  if (open) return void openUrl(`http://localhost:${open.local}`);
  const used = new Set((results[machineLabel(null)]?.ports ?? []).map((x) => x.port));
  for (const t of tunnels().values()) used.add(t.local);
  const local = freeLocalPort(p.port, used);
  say(cx, `Connecting to ${machine}:${p.port}…`);
  cx.spawn(async (cx) => {
    const started = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify",
      "--label", `tunnel=${machine}:${p.port}`, "--label", `tunnel_local=${local}`, "--",
      "timeout", TUNNEL_LIFETIME, "ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30", "-L", `127.0.0.1:${local}:localhost:${p.port}`,
      sshTargets[machine] ?? machine]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (started.code !== 0) return say(cx, `The tunnel didn't start: ${(started.stderr || "").trim()}`, "error");
    const address = JSON.parse(started.stdout).address;
    const up = await pollUntil(() => listening(local), (ms) => cx.sleep(ms), TUNNEL_WAIT_MS, POLL_MS);
    if (up) { openUrl(`http://localhost:${local}`); return say(cx, `Tunnel open on localhost:${local}`, "ok"); }
    const said = (await hc(["read", address]).catch(() => ({ stdout: "" }))).stdout.trim().split("\n").pop();
    await closeTunnel(address);
    say(cx, `The tunnel didn't open${said ? `: ${said}` : ""}. It needs ssh to ${machine} without a password.`, "error");
  });
}

// TERM (KILL when forced) to the process, or `docker stop` for a container, on the port's machine.
function stop(machine, p, force, cx) {
  const argv = p.container ? ["docker", "stop", p.container]
    : ["sh", "-c", KILL_SH, "sh", String(p.pid), String(p.port), force ? "KILL" : "TERM"];
  ui.dialog = null;
  say(cx, `Stopping :${p.port}…`);
  cx.spawn(async (cx) => {
    const answer = await inMachine(machine, argv);
    if (answer.code !== 0) return say(cx, `Couldn't stop it: ${(answer.stderr || "").trim().split("\n").pop() || `exit ${answer.code}`}`, "error");
    await cx.sleep(STOP_CHECK_MS);
    await read(machine);
    const still = (results[machineLabel(machine)]?.ports ?? []).find((x) => x.port === p.port && p.pid && x.pid === p.pid);
    if (!still) return say(cx, `:${p.port} is free`, "ok");
    say(cx, `Still listening on :${p.port}; it ignored the request to stop.`, "warn");
    if (!p.container) askStop(machine, still, true, cx);
  });
}

function askStop(machine, p, force, cx) {
  const lines = force ? [`Still listening on :${p.port}. Send KILL (kill -9) to pid ${p.pid} on ${machineLabel(machine)}?`, "It cannot clean up after itself."]
    : stopLines(machine, p, terminalOf(machine, p)).slice(1);
  ui.dialog = {
    title: force ? "Force stop" : stopLines(machine, p, null)[0].replace(/\?$/, ""),
    lines, action: force ? "Force stop" : "Stop", destructive: true,
    onConfirm: (cx) => stop(machine, p, force, cx),
    onCancel: (cx) => { ui.dialog = null; cx.notify(); },
  };
  cx.notify();
}

const FILTERS = ["common", "show all"];

export default {
  id: "ports",
  label: "ports",
  icon: "plug",
  ui,

  async load({ machines }) {
    const status = {};
    if (!targetsAsked) {
      targetsAsked = true;
      hc(["machine", "ls", "--json"]).then((l) => {
        for (const m of JSON.parse(l?.stdout ?? "{}").machines ?? []) sshTargets[m.name] = m.target || m.name;
      }).catch(() => { targetsAsked = false; });
    }
    for (const label of Object.keys(results)) if (!machines.some((m) => machineLabel(m) === label)) delete results[label];
    await Promise.all(machines.map(async (m) => {
      const r = results[machineLabel(m)];
      // A slow read runs on its own; this call answers from the cache.
      if (!r || (!r.loading && Date.now() - r.at >= REFRESH_MS)) {
        read(m).then(() => null, () => null); // background; the next tick sees it
      }
      status[slot(m)] = results[machineLabel(m)]?.unreachable ? "error" : "ok";
    }));
    return { state: { at: Date.now() }, machines: status };
  },

  // Enter in the search: open the first visible web port in Herdr's browser (remote too).
  submit(query) {
    for (const r of visible(query)) {
      const p = r.list.find(isWeb);
      if (p) return void openPage(r.machine, p);
    }
  },

  count: () => Object.values(results).reduce((n, r) => n + (r.ports ?? []).filter((p) => kindOf(p) === "app").length, 0),
  blocked: () => false,

  rows(_state, _probe, query) {
    return visible(query).flatMap((r) => r.list.map((p) => {
      const term = terminalOf(r.machine, p);
      return { key: portId(r.machine, p), target: term ? term.address : null };
    }));
  },

  view(_state, sel, cx, pick, { t, query }) {
    const all = Object.values(results);
    const hiddenCount = all.reduce((n, r) => n + (r.ports ?? []).length, 0) - visible("").reduce((n, r) => n + r.list.length, 0);
    const searching = Boolean(query?.trim());
    const tunnelMap = tunnels();
    const columns = [
      { label: "port", w: 56 },
      { label: "program / container", w: 190 },
      { label: "folder" },
      { label: "", w: 56 },
      { label: "terminal", w: 150 },
      { label: "", w: 110 },
    ];
    const panels = visible(query).filter((r) => !searching || r.list.length).map((r) => {
      const state = r.loading && !r.at ? "reading…" : r.error ?? `${r.list.length} ports`;
      const body = r.list.map((p) => {
        const term = terminalOf(r.machine, p);
        const tunnel = r.machine ? tunnelMap.get(`${r.machine}:${p.port}`) : null;
        const id = portId(r.machine, p);
        const detail = p.container ? p.folder ?? "container" : p.folder && p.folder !== "~" ? p.folder : p.command ?? "";
        const buttons = h_flex().w(110).flex_none().gap(2).justify_end()
          .when(isWeb(p), (el) => el
            .child(rowButton(t, { id: `open-${id}`, icon: "external-link", tooltip: "Open in Herdr's browser", onPress: () => openPage(r.machine, p) }))
            .child(rowButton(t, { id: `mine-${id}`, icon: "globe", tooltip: r.machine ? "My browser (through an ssh tunnel)" : "My browser", onPress: (cx) => myBrowser(r.machine, p, cx) })))
          .when(Boolean(tunnel), (el) => el.child(rowButton(t, { id: `untunnel-${id}`, icon: "unplug", tooltip: `Close tunnel (localhost:${tunnel.local})`, color: t.accent ?? t.ansi4,
            onPress: (cx) => cx.spawn(async (cx) => { await closeTunnel(tunnel.address); cx.notify(); }) })))
          .when(Boolean(term), (el) => el.child(rowButton(t, { id: `term-${id}`, icon: "terminal", tooltip: "Go to its terminal", onPress: () => goTo(term) })))
          .when(Boolean(p.pid || p.container), (el) => el.child(rowButton(t, { id: `stop-${id}`, icon: "square-x", tooltip: "Stop", color: t.ansi1, hover: t.ansi1, onPress: (cx) => askStop(r.machine, p, false, cx) })));
        return {
          key: id,
          cells: [
            div().font_semibold().child(`:${p.port}`),
            div().truncate().text_color(p.program || p.container ? t.foreground : t.muted).child(p.container ?? p.program ?? "system"),
            div().truncate().text_color(t.dim).child(tunnel ? `tunnel → localhost:${tunnel.local}` : detail),
            !p.local_only ? div().text_size(10).text_color(t.blocked).child("network") : "",
            div().truncate().text_color(t.muted).child(term ? term.where ?? term.name ?? term.address : ""),
            buttons,
          ],
          onClick: term ? (_e, cx) => pick(id, cx) : null,
        };
      });
      const empty = !r.list.length ? div().text_color(t.dim).child(r.error ?? (r.loading && !r.at ? "reading…" : "Nothing you started listens here.")) : null;
      return panel(t, {
        id: `ports-${machineLabel(r.machine)}`, icon: "plug", title: machineLabel(r.machine), right: state,
        body: [r.error && r.list.length ? div().text_color(t.blocked).child(r.error) : null, r.list.length ? table(t, columns, body, sel) : empty],
      });
    });
    const found = panels.length === 0 && searching
      ? div().px(12).py(12).text_color(t.dim).child(`No port matches "${query.trim()}". Escape clears the search.`) : null;
    return v_flex().id("ports-body").flex_1().min_h(0)
      .child(h_flex().flex_none().px(12).pt(10).gap(8).items_center()
        .child(chips(t, { id: "ports-filter", options: FILTERS.map((label) => ({ label })), selected: showAll ? 1 : 0, onSelect: (i, cx) => { showAll = i === 1; cx.notify(); } }))
        .child(div().text_size(10).text_color(t.dim).child(searching ? "searching everything, hidden ports too" : showAll ? "everything that listens" : `what you started · ${hiddenCount} more hidden`)))
      .child(v_flex().id("ports-list").flex_1().min_h(0).pb(12).overflow_y_scrollbar().children(panels).child(found)
        .child(div().px(12).pt(10).text_size(10).text_color(t.dim).child("network: reachable from other computers. Open: Herdr's browser, through that machine. My browser: yours, through an ssh tunnel for another machine.")));
  },
};

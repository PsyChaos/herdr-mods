// Ports: which program or container listens on which port, on this computer
// and on every connected machine. A row opens its page in the browser mod, or
// goes to the Herdr terminal that started it.
//
// Each machine is asked with one small Python script (PROBE): `ss -ltnpH` for
// listening TCP ports and their process, /proc for the process's command,
// folder and the Herdr terminal it inherited (HC_TERMINAL_ID), and `docker ps`
// for container ports. Only your own processes show their program; ports held
// by root show as "system".
// "My browser" opens a page in your own browser; another machine's port comes
// here through an ssh tunnel (a labelled Herdr terminal) first.
// "Stop" ends the program or container behind a port, after you confirm it.
// The search box filters every port, hidden ones too, by number, program,
// container, folder, command, terminal or machine; Enter opens the first match.
// Runs as a window: ctrl-shift-y ("mod.open:ports").

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { terminals, panes, machines, run, exec, hc, theme, props, closeOverlay, setShared, window as hostWindow } from "herdr";

const REFRESH_MS = 10000;
// The first port of the kernel's ephemeral range: above it are mostly ports a
// program picked at random for itself (editors, agents, debuggers).
const EPHEMERAL_FROM = 32768;
// Handed to the browser mod, which opens it right away (see browser/main.js).
const BROWSER_REQUEST = "browser.request";
// Ports that never serve a web page, so no "Open" for them.
const NOT_WEB = new Set([22, 25, 53, 631, 1025, 3306, 3307, 5037, 5353, 5355, 5432, 5433, 6379, 6380, 11211, 27017]);
const NOT_WEB_NAME = /(postgres|mariadb|mysql|redis|mongo|-pg|_db_|-db-|mailpit-smtp)/i;
// A tunnel's ssh ends on its own after this, like the browser mod's file server.
const TUNNEL_LIFETIME = "12h";
const TUNNEL_WAIT_MS = 6000;
const POLL_MS = 250;
// Where a tunnel goes when the remote port's number is taken here.
const TUNNEL_FALLBACK_FROM = 40000;

// Detached, so the browser it may start doesn't belong to Herdr's exec.
const OPEN_SH = 'command -v setsid >/dev/null && exec setsid -f "$0" "$1" >/dev/null 2>&1; exec "$0" "$1" >/dev/null 2>&1 &';
const LISTENING_SH = 'ss -ltnH "sport = :$1" | grep -q .';

// Look again this long after a stop, to see whether the port is free.
const STOP_CHECK_MS = 2500;

// Signals process $1 only if it still listens on port $2 (a pid can be reused
// in the seconds since the list was read).
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

const machineLabel = (name) => name ?? "This computer";

// "app": something you or an agent started (a container, or a program in a
// folder under home); "temp": a port a program picked for itself; the rest is
// the system's.
function kindOf(p) {
  if (p.container) return "app";
  if (p.port >= EPHEMERAL_FROM) return "temp";
  if (p.program && p.folder && p.folder.startsWith("~/")) return "app";
  return "system";
}

const isWeb = (p) => !NOT_WEB.has(p.port) && !NOT_WEB_NAME.test(p.container ?? "");

export default class Ports extends View {
  init(_props, cx) {
    this.results = {};
    this.showAll = false;
    // The row waiting for "Stop" to be confirmed, and what happened to stops.
    this.confirming = null;
    this.stops = {};
    // Per row: what "My browser" is doing ("connecting…" or an error).
    this.tunnelNotes = {};
    this.sshTargets = {};
    cx.spawn(async (cx) => {
      const list = await hc(["machine", "ls", "--json"]).catch(() => null);
      try {
        for (const m of JSON.parse(list?.stdout ?? "{}").machines ?? []) this.sshTargets[m.name] = m.target || m.name;
      } catch { /* the machine's name is its ssh target then */ }
    });
    this.search = InputState.new({ placeholder: "Search: 3000, node, redloop, ~/Projects…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", () => this.openFirst());
    this.search.focus();
    cx.timer.after(600, () => this.search.focus());
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  targets() {
    const remote = machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name);
    return [null, ...remote];
  }

  refresh(cx) {
    for (const machine of this.targets()) {
      const key = machineLabel(machine);
      const current = this.results[key];
      if (current?.loading) continue;
      this.results[key] = { ...(current ?? {}), loading: true };
      cx.spawn(async (cx) => {
        const answer = machine
          ? await hc(["exec", "--on", machine, "--", "python3", "-I", "-c", PROBE]).catch((e) => ({ code: 1, stderr: String(e) }))
          : await exec("python3", ["-I", "-c", PROBE]).catch((e) => ({ code: 1, stderr: String(e) }));
        let ports = current?.ports ?? [];
        let error = null;
        try {
          if (answer.code !== 0) throw new Error(answer.stderr?.trim() || "no answer");
          ports = JSON.parse(answer.stdout);
        } catch (e) {
          error = `Couldn't read ports: ${String(e?.message ?? e).split("\n")[0]}`;
        }
        this.results[key] = { machine, ports, error, loading: false, at: Date.now() };
        cx.notify();
      });
    }
    cx.notify();
  }

  // The Herdr terminal a port's program was started in, as terminals() names it.
  terminalOf(machine, p) {
    if (!p.terminal) return null;
    const address = machine ? `${machine}/${p.terminal}` : p.terminal;
    return terminals().find((t) => t.address === address && t.state === "live") ?? null;
  }

  // Every word of the search must appear somewhere in the row.
  matches(machine, p, words) {
    if (!words.length) return true;
    const term = this.terminalOf(machine, p);
    const text = [`:${p.port}`, p.container, p.program, p.folder, p.command,
      term?.where, term?.name, machineLabel(machine)].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  }

  words() {
    return this.search.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // What each machine shows: the search looks through everything, otherwise
  // "Show all" decides.
  visible() {
    const words = this.words();
    return this.targets().map((machine) => {
      const result = this.results[machineLabel(machine)] ?? { machine, loading: true };
      const ports = result.ports ?? [];
      const shown = words.length
        ? ports.filter((p) => this.matches(machine, p, words))
        : this.showAll ? ports : ports.filter((p) => kindOf(p) === "app");
      return { machine, result: { ...result, machine }, ports, shown };
    });
  }

  openFirst() {
    for (const { machine, shown } of this.visible()) {
      const p = shown.find(isWeb);
      if (p) return this.openPage(machine, p);
    }
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    if (this.confirming) this.confirming = null;
    else if (this.search.value()) this.search.set_value("");
    else closeOverlay(props()?.overlay);
    cx.stop_propagation();
    cx.notify();
  }

  openPage(machine, p) {
    setShared(BROWSER_REQUEST, { url: `localhost:${p.port}`, machine, at: Date.now() });
    run("mod.open", { name: "browser" });
  }

  // Ends what holds the port: `docker stop` for a container, otherwise TERM
  // (KILL when forced) to the process, on the port's machine.
  stop(machine, p, force, cx) {
    const id = `${machineLabel(machine)}-${p.port}`;
    const argv = p.container ? ["docker", "stop", p.container]
      : ["sh", "-c", KILL_SH, "sh", String(p.pid), String(p.port), force ? "KILL" : "TERM"];
    this.confirming = null;
    this.stops[id] = { state: "stopping", pid: p.pid };
    cx.notify();
    cx.spawn(async (cx) => {
      const answer = machine
        ? await hc(["exec", "--on", machine, "--", ...argv]).catch((e) => ({ code: 1, stderr: String(e) }))
        : await exec(argv[0], argv.slice(1)).catch((e) => ({ code: 1, stderr: String(e) }));
      if (answer.code !== 0) {
        this.stops[id] = { state: "error", text: (answer.stderr || "").trim().split("\n").pop() || `exit ${answer.code}` };
        cx.notify();
        return;
      }
      await cx.sleep(STOP_CHECK_MS);
      this.stops[id] = { state: "checking", pid: p.pid, force, since: Date.now() };
      this.refresh(cx);
    });
  }

  // After a stop, the next look tells whether the port is free.
  stopState(machine, p) {
    const id = `${machineLabel(machine)}-${p.port}`;
    const stop = this.stops[id];
    if (!stop) return null;
    const result = this.results[machineLabel(machine)];
    // Only a look started after the stop counts.
    if (stop.state === "checking" && !result?.loading && (result?.at ?? 0) > stop.since) {
      // Still listed by the same process: it ignored TERM.
      if (p.pid && p.pid === stop.pid) this.stops[id] = { state: "stubborn", pid: p.pid };
      else delete this.stops[id];
    }
    return this.stops[id] ?? null;
  }

  confirmRow(t, machine, p) {
    const id = `${machineLabel(machine)}-${p.port}`;
    const term = this.terminalOf(machine, p);
    const what = p.container ? `container ${p.container} (docker stop)` : `${p.program ?? "the program"} (pid ${p.pid})`;
    const warnings = [
      p.container ? "Its other ports stop too; a restart policy may start it again." : "This ends the whole program, not only this port.",
      term ? `It runs in Herdr terminal ${term.where ?? term.address}.` : null,
      !p.local_only ? "Other computers use it over the network too." : null,
    ].filter(Boolean).join(" ");
    return v_flex()
      .mx(10)
      .mb(4)
      .px(10)
      .py(7)
      .gap(5)
      .rounded(7)
      .border_1()
      .border_color(t.blocked)
      .text_size(11.5)
      .child(div().text_color(t.foreground).child(`Stop ${what} on ${machineLabel(machine)}, listening on :${p.port}?`))
      .child(div().text_size(10.5).text_color(t.dim).child(warnings))
      .child(h_flex().gap(6).justify_end()
        .child(this.button(t, `cancel-${id}`, "Cancel", (_e, cx) => { this.confirming = null; cx.notify(); }))
        .child(div().id(`yes-${id}`).px(8).py(1).rounded(5).flex_none().text_size(11).font_medium()
          .bg(t.blocked).text_color(t.background).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.stop(machine, p, false, cx))
          .child("Stop")));
  }

  // Live tunnels, by "machine:port": their terminal and the port here.
  tunnels() {
    const out = new Map();
    for (const term of terminals()) {
      if (term.state !== "live" || !term.labels?.tunnel) continue;
      out.set(term.labels.tunnel, { address: term.address, local: Number(term.labels.tunnel_local) });
    }
    return out;
  }

  openUrl(url, key, cx) {
    const opener = hostWindow()?.platform === "macos" ? "open" : "xdg-open";
    exec("sh", ["-c", OPEN_SH, opener, url]).then((r) => {
      if (r.code !== 0) { this.tunnelNotes[key] = `Couldn't open ${url}: ${(r.stderr || "").trim() || `exit ${r.code}`}`; cx.notify(); }
    }).catch(() => null);
  }

  // A port here for the tunnel: the same number when it is free, else one above 40000.
  freeLocalPort(port) {
    const used = new Set((this.results[machineLabel(null)]?.ports ?? []).map((x) => x.port));
    for (const t of this.tunnels().values()) used.add(t.local);
    if (!used.has(port)) return port;
    for (let candidate = TUNNEL_FALLBACK_FROM + (port % 10000); ; candidate += 1) if (!used.has(candidate)) return candidate;
  }

  async listening(port) {
    const r = await exec("sh", ["-c", LISTENING_SH, "sh", String(port)]).catch(() => ({ code: 1 }));
    return r.code === 0;
  }

  // Opens the port's page in your own browser. Another machine's port first gets
  // an ssh tunnel to a port here: `ssh -N -L 127.0.0.1:<here>:localhost:<port>`,
  // run as a Herdr terminal labelled tunnel=<machine>:<port>, so it shows, lasts
  // after this window closes, and "Close tunnel" ends it.
  myBrowser(machine, p, cx) {
    const key = `${machineLabel(machine)}-${p.port}`;
    if (!machine) { this.openUrl(`http://localhost:${p.port}`, key, cx); return; }
    const open = this.tunnels().get(`${machine}:${p.port}`);
    if (open) { this.openUrl(`http://localhost:${open.local}`, key, cx); return; }
    const local = this.freeLocalPort(p.port);
    this.tunnelNotes[key] = "connecting…";
    cx.notify();
    cx.spawn(async (cx) => {
      const started = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify",
        "--label", `tunnel=${machine}:${p.port}`, "--label", `tunnel_local=${local}`, "--",
        "timeout", TUNNEL_LIFETIME, "ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30", "-L", `127.0.0.1:${local}:localhost:${p.port}`,
        this.sshTargets[machine] ?? machine]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (started.code !== 0) {
        this.tunnelNotes[key] = `The tunnel didn't start: ${(started.stderr || "").trim()}`;
        cx.notify();
        return;
      }
      const address = JSON.parse(started.stdout).address;
      for (let waited = 0; waited < TUNNEL_WAIT_MS; waited += POLL_MS) {
        if (await this.listening(local)) {
          delete this.tunnelNotes[key];
          this.openUrl(`http://localhost:${local}`, key, cx);
          cx.notify();
          return;
        }
        await cx.sleep(POLL_MS);
      }
      // ssh says why (no key, host unreachable, port taken here) on its screen.
      const said = (await hc(["read", address]).catch(() => ({ stdout: "" }))).stdout.trim().split("\n").pop();
      await this.closeTunnel(address);
      this.tunnelNotes[key] = `The tunnel didn't open${said ? `: ${said}` : ""}. It needs ssh to ${machine} without a password.`;
      cx.notify();
    });
  }

  async closeTunnel(address) {
    await hc(["kill", address]).catch(() => null);
    await hc(["rm", address]).catch(() => null);
  }

  goTo(term) {
    if (panes().some((x) => x.terminal === term.address)) run("pane.focus", { terminal: term.address });
    else run("terminal.peek", { terminal: term.address });
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

  header(t, hidden, found) {
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
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Ports"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim)
        .child(found !== null ? `${found} found, hidden ones too`
          : this.showAll ? "everything that listens" : `what you started · ${hidden} more hidden`))
      .child(this.button(t, "toggle", this.showAll ? "Fewer" : "Show all", (_e, cx) => { this.showAll = !this.showAll; cx.notify(); }))
      .child(this.button(t, "refresh", "↻", (_e, cx) => this.refresh(cx)))
      .when(Boolean(overlay), (el) => el.child(this.button(t, "close", "✕", () => closeOverlay(overlay))));
  }

  machineHeader(t, result, count) {
    const state = result.loading && !result.at ? "reading…" : result.error ?? `${count} ports`;
    // A band on raised, as the PRs & CI window shows spaces.
    return h_flex()
      .mt(8)
      .mb(2)
      .px(10)
      .py(4)
      .gap(6)
      .items_center()
      .bg(t.raised ?? t.hover)
      .child(div().flex_none().font_semibold().text_size(12.5).text_color(t.foreground).child(machineLabel(result.machine)))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(result.error ? t.blocked : t.dim).child(state));
  }

  // ":8080  redloop-frontend-1        network   Open  Terminal"
  //         ~/Desktop/Projects/redloop2
  row(t, machine, p) {
    const term = this.terminalOf(machine, p);
    const name = p.container ?? p.program ?? "system";
    const detail = p.container ? p.folder ?? "container" : p.folder && p.folder !== "~" ? p.folder : p.command ?? "";
    const where = term ? term.where ?? term.name ?? term.address : null;
    const id = `${machineLabel(machine)}-${p.port}`;
    const tunnel = machine ? this.tunnels().get(`${machine}:${p.port}`) : null;
    return h_flex()
      .id(`port-${id}`)
      .px(10)
      .py(3)
      .gap(8)
      .items_center()
      .text_size(12)
      .hover((s) => s.bg(t.hover))
      .child(div().w(52).flex_none().font_semibold().text_color(t.foreground).child(`:${p.port}`))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(p.program || p.container ? t.foreground : t.muted).child(name))
        .when(Boolean(detail || where), (el) => el.child(div().truncate().text_size(10).text_color(t.dim)
          .child([detail, where ? `started in ${where}` : null].filter(Boolean).join(" · "))))
        .when(Boolean(tunnel), (el) => el.child(div().truncate().text_size(10).text_color(t.accent)
          .child(`tunnel → localhost:${tunnel.local} on this computer`))))
      .when(!p.local_only, (el) => el.child(div().flex_none().text_size(10).text_color(t.blocked).child("network")))
      .when(isWeb(p), (el) => el
        .child(this.button(t, `open-${id}`, "Open", () => this.openPage(machine, p)))
        .child(this.button(t, `mine-${id}`, "My browser", (_e, cx) => this.myBrowser(machine, p, cx))))
      .when(Boolean(tunnel), (el) => el.child(this.button(t, `untunnel-${id}`, "Close tunnel", (_e, cx) => {
        this.closeTunnel(tunnel.address).then(() => cx.notify());
      })))
      .when(Boolean(term), (el) => el.child(this.button(t, `term-${id}`, "Terminal", () => this.goTo(term))))
      .when(Boolean(p.pid || p.container), (el) => el.child(this.button(t, `stop-${id}`, "Stop", (_e, cx) => {
        this.confirming = this.confirming === id ? null : id;
        delete this.stops[id];
        cx.notify();
      })));
  }

  // A row, and under it the confirmation or what its stop did.
  rows(t, machine, p) {
    const id = `${machineLabel(machine)}-${p.port}`;
    const out = [this.row(t, machine, p)];
    if (this.confirming === id) out.push(this.confirmRow(t, machine, p));
    const note = this.tunnelNotes[id];
    if (note) out.push(h_flex().px(10).pl(70).pb(3).text_size(10.5)
      .text_color(note === "connecting…" ? t.dim : t.blocked).child(div().truncate().child(note)));
    const stop = this.stopState(machine, p);
    if (stop) {
      const line = h_flex().px(10).pl(70).pb(3).gap(8).items_center().text_size(10.5);
      if (stop.state === "error") out.push(line.text_color(t.blocked).child(`Couldn't stop it: ${stop.text}`));
      else if (stop.state === "stubborn") {
        out.push(line.text_color(t.blocked).child(div().child("Still listening; it ignored the request to stop."))
          .when(!p.container, (el) => el.child(this.button(t, `force-${id}`, "Force stop (kill -9)", (_e, cx) => this.stop(machine, p, true, cx)))));
      } else out.push(line.text_color(t.dim).child("stopping…"));
    }
    return out;
  }

  render(_props, cx) {
    const t = theme();
    const searching = this.words().length > 0;
    let hidden = 0;
    let found = 0;
    const sections = [];
    for (const { machine, result, ports, shown } of this.visible()) {
      hidden += ports.length - shown.length;
      found += shown.length;
      // While searching, a machine with nothing matching stays out of the way.
      if (searching && shown.length === 0) continue;
      sections.push(this.machineHeader(t, result, shown.length));
      sections.push(...shown.flatMap((p) => this.rows(t, machine, p)));
      if (!searching && !result.loading && !result.error && shown.length === 0) {
        sections.push(div().px(10).py(3).text_size(11).text_color(t.dim).child("Nothing you started listens here."));
      }
    }
    if (searching && found === 0) {
      sections.push(div().px(10).py(12).text_size(11).text_color(t.dim)
        .child(`No port matches "${this.search.value().trim()}". Esc clears the search.`));
    }
    return v_flex()
      .id("ports")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .text_size(13)
      .child(this.header(t, hidden, searching ? found : null))
      .child(div().flex_none().px(10).pt(8).pb(2)
        .child(Input.new(this.search).h(30).px(9).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(12).text_color(t.foreground)))
      .child(v_flex().id("port-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(sections))
      .child(div().flex_none().px(10).py(5).border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child("\"network\": reachable from other computers, not only this machine. Open: Herdr's browser, through that machine. My browser: yours, through an ssh tunnel for another machine."));
  }
}

// Docker: the containers on this computer and on every connected machine,
// grouped by compose project. Start, stop, restart; their logs and a shell in
// them open as Herdr terminals here (over ssh for another machine), in a pane
// beside the one that was focused.
//
// Each machine is asked with one small Python script (PROBE in model.js) every
// 10 s while the window is open. Stop and Restart ask first. The search looks
// through machine, project, folder, name, image, service, state and ports;
// All / Running / Stopped filter on top of it (remembered in shared state).
// Runs as a window: ctrl-shift-s ("mod.open:docker"). Opening a terminal
// leaves the window open, so several can be opened one after another.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { terminals, panes, machines, spaces, run, exec, hc, theme, props, closeOverlay, focused, shared, setShared } from "herdr";
import { PROBE, machineLabel, FILTERS, isUp, passes, matches, projects, stateColor } from "./model.js";

const REFRESH_MS = 10000;
const FILTER_KEY = "docker.filter";
// {search, at} from the machines mod's "Open in Docker": a fresh one fills the
// search when the window opens.
const REQUEST_KEY = "docker.request";
const REQUEST_FRESH_MS = 5000;
const REQUEST_POLL_MS = 500;
const LOG_LINES = "300";
const POLL_MS = 250;
const PANE_WAIT_MS = 4000;

// Logs follow the container; when it stops (or was stopped already) the pane
// stays until Enter, so what it printed can still be read.
const LOGS_SH = 'docker logs -f --tail "$1" "$2"; printf "\\n[%s is not running: the logs end here. Press Enter to close.]" "$2"; read -r _';
const SHELL_SH = "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";

// One word for a remote shell.
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const ACTIONS = {
  start: { label: "Start", busy: "starting…" },
  unpause: { label: "Resume", busy: "resuming…" },
  restart: { label: "Restart", busy: "restarting…", confirm: "It stops and starts again: whatever is connected to it loses the connection." },
  stop: { label: "Stop", busy: "stopping…", confirm: "Whatever uses it loses it. A restart policy (restart: always) may start it again." },
};

const errorOf = (r) => (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.code}`;

async function waitFor(test, cx) {
  for (let waited = 0; waited < PANE_WAIT_MS; waited += POLL_MS) {
    if (test()) return true;
    await cx.sleep(POLL_MS);
  }
  return test();
}

export default class Docker extends View {
  init(_props, cx) {
    this.results = {};
    // "machine/id/verb" waiting for its confirmation; per container, what an
    // action is doing or why it failed; the footer's last note.
    this.confirming = null;
    this.busy = {};
    // Logs/shell labels whose terminal is starting.
    this.opening = new Set();
    this.note = null;
    this.before = focused();
    // ssh targets of the machines, for logs and shells of another machine's
    // containers seen from this computer (see where()).
    this.sshTargets = {};
    cx.spawn(async () => {
      const list = await hc(["machine", "ls", "--json"]).catch(() => null);
      try {
        for (const m of JSON.parse(list?.stdout ?? "{}").machines ?? []) this.sshTargets[m.name] = m.target || m.name;
      } catch { /* the machine's name is its ssh target then */ }
    });
    this.search = InputState.new({ placeholder: "Search: postgres, redloop, 5432, exited, 192.168…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.takeRequest();
    // Also while open: "Open in Docker" only brings an open window forward.
    cx.timer.every(REQUEST_POLL_MS, () => this.takeRequest());
    this.search.focus();
    cx.timer.after(600, () => this.search.focus());
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  takeRequest() {
    const request = shared(REQUEST_KEY);
    if (!request?.search) return;
    setShared(REQUEST_KEY, null);
    if (Date.now() - (request.at ?? 0) < REQUEST_FRESH_MS) this.search.set_value(request.search);
  }

  filter() {
    const value = shared(FILTER_KEY);
    return FILTERS.some((f) => f.key === value) ? value : "all";
  }

  targets() {
    return [null, ...machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name)];
  }

  onMachine(machine, argv) {
    const answer = machine ? hc(["exec", "--on", machine, "--", ...argv]) : exec(argv[0], argv.slice(1));
    return answer.catch((e) => ({ code: 1, stderr: String(e) }));
  }

  refresh(cx) {
    for (const machine of this.targets()) {
      if (this.results[machineLabel(machine)]?.loading) continue;
      cx.spawn(async (cx) => this.load(machine, cx));
    }
    cx.notify();
  }

  // Reads one machine's containers.
  async load(machine, cx) {
    const key = machineLabel(machine);
    const current = this.results[key];
    this.results[key] = { ...(current ?? {}), machine, loading: true };
    const answer = await this.onMachine(machine, ["python3", "-I", "-c", PROBE]);
    let next = { containers: current?.containers ?? [] };
    try {
      if (answer.code !== 0) throw new Error(errorOf(answer));
      next = JSON.parse(answer.stdout);
    } catch (e) {
      next.error = `Couldn't read containers: ${String(e?.message ?? e).split("\n")[0]}`;
    }
    this.results[key] = { machine, containers: [], ...next, loading: false, at: Date.now() };
    cx.notify();
  }

  words() {
    return this.search.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    if (this.confirming) this.confirming = null;
    else if (this.search.value()) this.search.set_value("");
    else closeOverlay(props()?.overlay);
    cx.stop_propagation();
    cx.notify();
  }

  // docker start / stop / restart / unpause <id> on the container's machine.
  // Its buttons stay off until the machine is read again, so the row never
  // offers the old state's button meanwhile.
  act(machine, c, verb, cx) {
    const id = `${machineLabel(machine)}/${c.id}`;
    if (this.busy[id]?.text) return;
    this.confirming = null;
    this.busy[id] = { text: ACTIONS[verb].busy };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.onMachine(machine, ["docker", verb, c.id]);
      await this.load(machine, cx);
      if (r.code === 0) delete this.busy[id];
      else this.busy[id] = { error: `${ACTIONS[verb].label} failed: ${errorOf(r)}` };
      cx.notify();
    });
  }

  // Where a logs or shell terminal runs. Herdr puts a terminal's pane only
  // beside a pane of its own machine, so it runs on the machine of the space
  // you look at: the container's own docker when that is the same machine,
  // ssh to it when you look at this computer. Else (you look at another
  // machine than the container's) it runs on the container's machine and gets
  // a tab in that machine's space. → {on, argv, beside}
  where(machine, here) {
    const view = focused() ?? this.before;
    const viewing = spaces().find((s) => s.id === view?.space)?.machine ?? null;
    if (viewing === machine) return { on: machine, argv: here, beside: true };
    if (viewing === null) {
      return { on: null, beside: true, argv: ["ssh", "-t", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30",
        this.sshTargets[machine] ?? machine, here.map(quote).join(" ")] };
    }
    return { on: machine, argv: here, beside: false };
  }

  // Logs or a shell as a Herdr terminal (see where()), labelled
  // docker=<machine>/<name>/<kind> so a second click goes to the same one.
  openTerminal(machine, c, kind, cx) {
    const label = `${machineLabel(machine)}/${c.name}/${kind}`;
    const what = kind === "logs" ? `the logs of ${c.name}` : `a shell in ${c.name}`;
    const open = terminals().find((t) => t.state === "live" && t.labels?.docker === label);
    if (open) { this.show(open.address, cx, what); return; }
    // A second click while it starts would start a second one.
    if (this.opening.has(label)) return;
    this.opening.add(label);
    const here = kind === "logs" ? ["sh", "-c", LOGS_SH, "sh", LOG_LINES, c.name]
      : ["docker", "exec", "-it", c.name, "sh", "-c", SHELL_SH];
    const { on, argv, beside } = this.where(machine, here);
    this.note = { text: `Opening ${what}…` };
    cx.notify();
    cx.spawn(async (cx) => {
      const started = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", ...(on ? ["--on", on] : []),
        "--label", `docker=${label}`, "--", ...argv]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (started.code !== 0) {
        this.opening.delete(label);
        this.note = { text: `It didn't start: ${errorOf(started)}`, bad: true };
        cx.notify();
        return;
      }
      const address = JSON.parse(started.stdout).address;
      // Herdr learns about a new terminal a moment after hc starts it; from
      // then on the label finds it.
      const listed = await waitFor(() => terminals().some((t) => t.address === address), cx);
      this.opening.delete(label);
      if (!listed) {
        this.note = { text: `${address} started but Herdr doesn't list it.`, bad: true };
        cx.notify();
        return;
      }
      this.show(address, cx, what, beside);
    });
  }

  // Focuses its pane, or gives it one beside the pane focused before this
  // window opened (its own tab when that fails). The window stays.
  show(address, cx, what, beside = true) {
    const shown = () => panes().some((p) => p.terminal === address);
    const done = (text) => { this.note = { text }; cx.notify(); };
    if (shown()) { run("pane.focus", { terminal: address }); done(`${what ?? "It"} is already open: its pane has the focus.`); return; }
    cx.spawn(async (cx) => {
      const view = focused() ?? this.before;
      if (beside && view?.pane) {
        run("pane.focus", { pane: view.pane });
        run("terminal.keep", { terminal: address, place: "right" });
        if (await waitFor(shown, cx)) { done(`Opened ${what ?? address} in a pane.`); return; }
      }
      run("terminal.keep", { terminal: address });
      if (await waitFor(shown, cx)) { done(`Opened ${what ?? address} in a tab.`); return; }
      this.note = { text: `Herdr couldn't give ${address} a pane; it runs in the background (hc read ${address}).`, bad: true };
      cx.notify();
    });
  }

  // off: drawn faded, and clicks do nothing.
  button(t, id, label, onClick, off = false) {
    const el = div().id(id).px(6).py(1).rounded(5).flex_none().text_size(11)
      // A press that isn't stopped drags the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(label);
    if (off) return el.text_color(t.dim).opacity(0.5);
    return el.text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick);
  }

  // "All 33 · Running 25 · Stopped 8", the chosen one on `selected`.
  filterBar(t, counts) {
    const current = this.filter();
    return h_flex().flex_none().gap(2).children(FILTERS.map((f) =>
      div().id(`filter-${f.key}`).px(7).py(1).rounded(5).text_size(11).cursor_pointer()
        .text_color(f.key === current ? t.foreground : t.muted)
        .when(f.key === current, (el) => el.bg(t.selected ?? t.hover).font_medium())
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => setShared(FILTER_KEY, f.key))
        .child(`${f.label} ${counts[f.key]}`)));
  }

  header(t, counts) {
    const overlay = props()?.overlay;
    return h_flex().h(32).flex_none().px(10).gap(6).items_center().text_size(12).border_b(1).border_color(t.border)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Docker"))
      .child(div().flex_1())
      .child(this.filterBar(t, counts))
      .child(this.button(t, "refresh", "↻", (_e, cx) => this.refresh(cx)))
      .when(Boolean(overlay), (el) => el.child(this.button(t, "close", "✕", () => closeOverlay(overlay))));
  }

  machineBand(t, result) {
    const all = result.containers ?? [];
    const up = all.filter(isUp).length;
    const state = result.loading && !result.at ? "reading…"
      : result.error ?? (result.missing ? "Docker isn't installed here." : `${up} running · ${all.length - up} stopped`);
    return h_flex().mt(8).px(10).py(4).gap(6).items_center().bg(t.raised ?? t.hover)
      .child(div().flex_none().font_semibold().text_size(12.5).text_color(t.foreground).child(machineLabel(result.machine)))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(result.error ? t.blocked : t.dim).child(state));
  }

  projectLine(t, p) {
    return h_flex().px(10).pt(6).pb(1).gap(6).items_center().text_size(11)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(p.name ?? "Other containers"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(p.folder ?? ""))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(`${p.up}/${p.containers.length} running`));
  }

  // ● redloop-api-1                         Logs Shell Restart Stop
  //   redloop-api · Up 5 hours (healthy) · :8000 · 0.4% 120MiB
  row(t, machine, c) {
    const id = `${machineLabel(machine)}/${c.id}`;
    const up = c.state === "running";
    const detail = [c.image, c.status, c.ports.map((p) => `:${p}`).join(" "),
      up && c.cpu ? `${c.cpu} ${c.memory}` : null].filter(Boolean).join(" · ");
    const verbs = c.state === "paused" ? ["unpause", "stop"] : isUp(c) ? ["restart", "stop"] : ["start"];
    const acting = Boolean(this.busy[id]?.text);
    const ask = (verb) => (_e, cx) => {
      if (!ACTIONS[verb].confirm) { this.act(machine, c, verb, cx); return; }
      const key = `${id}/${verb}`;
      this.confirming = this.confirming === key ? null : key;
      cx.notify();
    };
    return h_flex().id(`c-${id}`).px(10).pl(14).py(3).gap(8).items_center().text_size(12)
      .hover((s) => s.bg(t.hover))
      .child(div().flex_none().size(7).rounded(4).bg(stateColor(t, c)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(isUp(c) ? t.foreground : t.muted).child(c.name))
        .child(div().truncate().text_size(10).text_color(t.dim).child(detail)))
      .child(this.button(t, `logs-${id}`, "Logs", (_e, cx) => this.openTerminal(machine, c, "logs", cx),
        this.opening.has(`${machineLabel(machine)}/${c.name}/logs`)))
      .when(up, (el) => el.child(this.button(t, `shell-${id}`, "Shell", (_e, cx) => this.openTerminal(machine, c, "shell", cx),
        acting || this.opening.has(`${machineLabel(machine)}/${c.name}/shell`))))
      .children(verbs.map((verb) => this.button(t, `${verb}-${id}`, ACTIONS[verb].label, ask(verb), acting)));
  }

  confirmBox(t, machine, c, verb) {
    const id = `${machineLabel(machine)}/${c.id}`;
    const action = ACTIONS[verb];
    return v_flex().mx(10).mb(4).px(10).py(7).gap(5).rounded(7).border_1().border_color(t.blocked).text_size(11.5)
      .child(div().text_color(t.foreground).child(`${action.label} ${c.name} on ${machineLabel(machine)}?`))
      .child(div().text_size(10.5).text_color(t.dim).child(action.confirm))
      .child(h_flex().gap(6).justify_end()
        .child(this.button(t, `cancel-${id}`, "Cancel", (_e, cx) => { this.confirming = null; cx.notify(); }))
        .child(div().id(`yes-${id}`).px(8).py(1).rounded(5).flex_none().text_size(11).font_medium()
          .bg(t.blocked).text_color(t.background).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.act(machine, c, verb, cx))
          .child(action.label)));
  }

  // A container's row, then its confirmation or what its action is doing.
  rows(t, machine, c) {
    const id = `${machineLabel(machine)}/${c.id}`;
    const out = [this.row(t, machine, c)];
    const verb = this.confirming?.startsWith(`${id}/`) ? this.confirming.slice(id.length + 1) : null;
    if (verb) out.push(this.confirmBox(t, machine, c, verb));
    const busy = this.busy[id];
    if (busy) out.push(div().px(10).pl(29).pb(3).text_size(10.5).text_color(busy.error ? t.blocked : t.dim)
      .child(busy.error ?? busy.text));
    return out;
  }

  render(_props, cx) {
    const t = theme();
    const words = this.words();
    const filter = this.filter();
    const counts = { all: 0, running: 0, stopped: 0 };
    const sections = [];
    for (const machine of this.targets()) {
      const result = this.results[machineLabel(machine)] ?? { machine, loading: true };
      const found = (result.containers ?? []).filter((c) => matches(machine, c, words));
      for (const c of found) { counts.all += 1; counts[isUp(c) ? "running" : "stopped"] += 1; }
      const shown = found.filter((c) => passes(filter, c));
      // Searching or filtering, a machine with nothing left stays out of the way.
      if ((words.length || filter !== "all") && !shown.length && !result.error) continue;
      sections.push(this.machineBand(t, result));
      for (const p of projects(shown)) {
        sections.push(this.projectLine(t, p));
        sections.push(...p.containers.flatMap((c) => this.rows(t, machine, c)));
      }
      if (!result.loading && !result.error && !result.missing && !shown.length) {
        sections.push(div().px(10).py(3).text_size(11).text_color(t.dim).child("No containers here."));
      }
    }
    if (!sections.length) {
      const what = filter === "all" ? "container" : `${filter} container`;
      sections.push(div().px(10).py(12).text_size(11).text_color(t.dim)
        .child(words.length ? `No ${what} matches "${this.search.value().trim()}". Esc clears the search.` : `No ${what} on any machine.`));
    }
    return v_flex().id("docker").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().text_size(13)
      .child(this.header(t, counts))
      .child(div().flex_none().px(10).pt(8).pb(2)
        .child(Input.new(this.search).h(30).px(9).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(12).text_color(t.foreground)))
      .child(v_flex().id("container-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(sections))
      .child(div().flex_none().px(10).py(5).border_t(1).border_color(t.border).text_size(10)
        .text_color(this.note?.bad ? t.blocked : t.dim)
        .child(this.note?.text ?? "Logs and Shell open beside your pane (over ssh for another machine). Stop and Restart ask first."));
  }
}

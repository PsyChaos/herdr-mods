// Deck's docker tab: the containers of this computer and every machine, one panel per
// machine and compose project. Start, stop, restart; logs and a shell open as Herdr terminals.
// Each machine is read by one Python script (PROBE) every 10 s, in the background.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, panes, spaces, run, exec, hc, focused, shared, setShared } from "herdr";
import { PROBE, machineLabel, FILTERS, isUp, passes, matches, projects, stateColor, released } from "../docker-model.js";
import { panel, table, chips, rowButton, dot } from "../ui.js";

const REFRESH_MS = 10000;
const FILTER_KEY = "docker.filter";
const POLL_MS = 250;
const PANE_WAIT_MS = 4000;
const LOG_LINES = "300";

// Logs follow the container; when it stops the pane stays until Enter, so the output can be read.
const LOGS_SH = 'docker logs -f --tail "$1" "$2"; printf "\\n[%s is not running: the logs end here. Press Enter to close.]" "$2"; read -r _';
const SHELL_SH = "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const ACTIONS = {
  start: { label: "Start", busy: "starting…", icon: "play" },
  unpause: { label: "Resume", busy: "resuming…", icon: "play" },
  restart: { label: "Restart", busy: "restarting…", icon: "rotate-cw", confirm: "It stops and starts again: whatever is connected to it loses the connection." },
  stop: { label: "Stop", busy: "stopping…", icon: "square", confirm: "Whatever uses it loses it. A restart policy (restart: always) may start it again." },
};

const errorOf = (r) => (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.code}`;

// Module scope: a load in flight must not overwrite what the user is doing.
export const ui = { dialog: null, note: null, query: null };
const results = {}; // machine label -> {machine, containers, error, missing, at, loading, reached}
const busy = {}; // "machine/id" -> {text} | {error}
const opening = new Set(); // logs/shell labels whose terminal is starting
const sshTargets = {};
let targetsAsked = false;

const say = (text, level = "info") => { ui.note = { text, level, at: Date.now() }; };
const onMachine = (machine, argv) => exec(argv[0], argv.slice(1), machine ? { on: machine } : {});

async function waitFor(test, cx) {
  for (let waited = 0; waited < PANE_WAIT_MS; waited += POLL_MS) {
    if (test()) return true;
    await cx.sleep(POLL_MS);
  }
  return test();
}

// Reads one machine's containers. Only an unreachable machine counts as "reached: false".
async function read(machine) {
  const key = machineLabel(machine);
  const current = results[key];
  results[key] = { containers: [], ...current, machine, loading: true };
  let next = { containers: current?.containers ?? [], reached: true };
  try {
    const answer = await onMachine(machine, ["python3", "-I", "-c", PROBE]).catch((e) => { next.reached = false; throw e; });
    if (answer.code !== 0) throw new Error(errorOf(answer));
    next = { ...JSON.parse(answer.stdout), reached: true };
  } catch (e) {
    next.error = `Couldn't read containers: ${String(e?.message ?? e).split("\n")[0]}`;
  }
  results[key] = { machine, containers: [], ...next, loading: false, at: Date.now() };
}

// Where a logs or shell terminal runs. Herdr puts a terminal's pane only beside a pane of its own
// machine: the container's docker directly when you look at that machine, ssh to it from this
// computer, else on the container's machine as a tab of its space.
function where(machine, here) {
  const viewing = spaces().find((s) => s.id === focused()?.space)?.machine ?? null;
  if (viewing === machine) return { on: machine, argv: here, beside: true };
  if (viewing === null) {
    return { on: null, beside: true, argv: ["ssh", "-t", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30",
      sshTargets[machine] ?? machine, here.map(quote).join(" ")] };
  }
  return { on: machine, argv: here, beside: false };
}

// docker <verb> <id> on the container's machine; its buttons stay off until the machine is read again.
function act(machine, c, verb, cx) {
  const id = `${machineLabel(machine)}/${c.id}`;
  if (busy[id]?.text) return;
  busy[id] = { text: ACTIONS[verb].busy };
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await onMachine(machine, ["docker", verb, c.id]).catch((e) => ({ code: 1, stderr: String(e) }));
    await read(machine);
    // Success: the lock stays until a published snapshot holds the refreshed read (see view()).
    if (r.code === 0) busy[id] = { ...busy[id], after: results[machineLabel(machine)]?.at };
    else { busy[id] = { error: `${ACTIONS[verb].label} failed: ${errorOf(r)}` }; say(`${ACTIONS[verb].label} ${c.name} failed`, "error"); }
    cx.notify();
  });
}

const ask = (machine, c, verb, cx) => {
  if (!ACTIONS[verb].confirm) return act(machine, c, verb, cx);
  const close = (cx) => { ui.dialog = null; cx.notify(); };
  ui.dialog = {
    title: `${ACTIONS[verb].label} ${c.name} on ${machineLabel(machine)}?`, lines: [ACTIONS[verb].confirm],
    action: ACTIONS[verb].label, destructive: true,
    onConfirm: (cx) => { ui.dialog = null; act(machine, c, verb, cx); },
    onCancel: close,
  };
  cx.notify();
};

// Focuses its pane, or gives it one beside the focused pane (its own tab when that fails).
function show(address, cx, what, beside) {
  const shown = () => panes().some((p) => p.terminal === address);
  if (shown()) { run("pane.focus", { terminal: address }); say(`${what} is already open: its pane has the focus.`); cx.notify(); return; }
  cx.spawn(async (cx) => {
    const view = focused();
    if (beside && view?.pane) {
      run("pane.focus", { pane: view.pane });
      run("terminal.keep", { terminal: address, place: "right" });
      if (await waitFor(shown, cx)) { say(`Opened ${what} in a pane.`, "ok"); cx.notify(); return; }
    }
    run("terminal.keep", { terminal: address });
    if (await waitFor(shown, cx)) say(`Opened ${what} in a tab.`, "ok");
    else say(`Herdr couldn't give ${address} a pane; it runs in the background (hc read ${address}).`, "error");
    cx.notify();
  });
}

// Logs or a shell as a Herdr terminal, labelled docker=<machine>/<name>/<kind> so a second click goes to it.
function openTerminal(machine, c, kind, cx) {
  const label = `${machineLabel(machine)}/${c.name}/${kind}`;
  const what = kind === "logs" ? `the logs of ${c.name}` : `a shell in ${c.name}`;
  const open = terminals().find((t) => t.state === "live" && t.labels?.docker === label);
  if (open) return show(open.address, cx, what, true);
  if (opening.has(label)) return; // a second click while it starts would start a second one
  opening.add(label);
  const here = kind === "logs" ? ["sh", "-c", LOGS_SH, "sh", LOG_LINES, c.name] : ["docker", "exec", "-it", c.name, "sh", "-c", SHELL_SH];
  const { on, argv, beside } = where(machine, here);
  say(`Opening ${what}…`);
  cx.notify();
  cx.spawn(async (cx) => {
    const started = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", ...(on ? ["--on", on] : []),
      "--label", `docker=${label}`, "--", ...argv]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (started.code !== 0) {
      opening.delete(label);
      say(`It didn't start: ${errorOf(started)}`, "error");
      return cx.notify();
    }
    const address = JSON.parse(started.stdout).address;
    // Herdr lists a new terminal a moment after hc starts it.
    const listed = await waitFor(() => terminals().some((t) => t.address === address), cx);
    opening.delete(label);
    if (!listed) { say(`${address} started but Herdr doesn't list it.`, "error"); return cx.notify(); }
    show(address, cx, what, beside);
  });
}

const filterOf = () => {
  const value = shared(FILTER_KEY);
  return FILTERS.some((f) => f.key === value) ? value : "all";
};
const wordsOf = (query) => (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

export default {
  ui,
  id: "docker",
  label: "docker",
  icon: "container",

  async load({ machines }) {
    if (!targetsAsked) {
      targetsAsked = true;
      // ssh targets of the machines, for logs and shells of another machine's containers.
      hc(["machine", "ls", "--json"]).then((l) => {
        for (const m of JSON.parse(l.stdout ?? "{}").machines ?? []) sshTargets[m.name] = m.target || m.name;
      }).catch(() => {});
    }
    const status = {};
    const now = Date.now();
    for (const machine of machines) {
      const r = results[machineLabel(machine)];
      status[machine ?? "here"] = r && !r.reached ? "error" : "ok";
      if (!r?.loading && (!r || now - r.at >= REFRESH_MS)) read(machine); // in the background
    }
    return { state: { results: { ...results }, machines }, machines: status };
  },

  count(state) {
    return state ? Object.values(state.results).reduce((n, r) => n + (r.containers ?? []).filter(isUp).length, 0) : 0;
  },

  blocked: (state) => Boolean(state) && Object.values(state.results).some((r) => (r.containers ?? []).some((c) => c.health === "unhealthy" || c.state === "dead")),

  rows: () => [],

  view(state, _sel, _cx, _pick, { t, query }) {
    const words = wordsOf(query);
    const filter = filterOf();
    const counts = { all: 0, running: 0, stopped: 0 };
    const panels = [];
    for (const machine of state?.machines ?? []) {
      const result = state.results[machineLabel(machine)] ?? { machine, loading: true, containers: [] };
      const found = (result.containers ?? []).filter((c) => matches(machine, c, words));
      for (const c of found) { counts.all += 1; counts[isUp(c) ? "running" : "stopped"] += 1; }
      const shown = found.filter((c) => passes(filter, c));
      const problem = result.loading && !result.at ? "reading…"
        : result.error ?? (result.missing ? "docker isn't installed here." : null);
      const name = machineLabel(machine);
      // Searching or filtering, a machine with nothing left stays out of the way.
      if ((words.length || filter !== "all") && !shown.length && !result.error) continue;
      if (problem || !shown.length) {
        panels.push(panel(t, { id: `docker-${name}`, icon: "container", title: name, right: problem ? "" : "0 containers",
          body: div().text_color(result.error ? t.ansi1 : t.dim).child(problem ?? "No containers here.") }));
        continue;
      }
      for (const p of projects(shown)) {
        const rows = p.containers.map((c) => {
          const id = `${name}/${c.id}`;
          if (released(busy[id], result.at)) delete busy[id]; // the snapshot is fresh now
          const up = c.state === "running";
          const acting = Boolean(busy[id]?.text);
          const verbs = c.state === "paused" ? ["unpause", "stop"] : isUp(c) ? ["restart", "stop"] : ["start"];
          const opens = (kind) => opening.has(`${name}/${c.name}/${kind}`);
          const b = busy[id];
          return {
            key: id,
            cells: [
              h_flex().gap(6).items_center().min_w(0).child(dot(t, stateColor(t, c), 6))
                .child(div().truncate().text_color(isUp(c) ? t.foreground : t.muted).child(c.name)),
              [c.image, c.status].filter(Boolean).join(" · "),
              c.ports.map((x) => `:${x}`).join(" "),
              up && c.cpu ? `${c.cpu} ${c.memory}` : "",
              h_flex().gap(2).justify_end()
                .child(rowButton(t, { id: `logs-${id}`, icon: "scroll-text", tooltip: "Logs", disabled: opens("logs"), onPress: (cx) => openTerminal(machine, c, "logs", cx) }))
                .when(up, (el) => el.child(rowButton(t, { id: `shell-${id}`, icon: "terminal", tooltip: "Shell", disabled: acting || opens("shell"), onPress: (cx) => openTerminal(machine, c, "shell", cx) })))
                .children(verbs.map((verb) => rowButton(t, { id: `${verb}-${id}`, icon: ACTIONS[verb].icon, tooltip: ACTIONS[verb].label,
                  disabled: acting, hover: verb === "stop" ? t.ansi1 : t.foreground, onPress: (cx) => ask(machine, c, verb, cx) }))),
            ],
            under: b ? div().pl(26).pb(3).text_size(10.5).text_color(b.error ? t.ansi1 : t.dim).child(b.error ?? b.text) : null,
          };
        });
        panels.push(panel(t, { id: `docker-${name}-${p.name ?? "other"}`, icon: "container", title: p.name ?? "Other containers",
          right: [name, p.folder, `${p.up}/${p.containers.length} running`].filter(Boolean).join(" · "),
          body: table(t, [{ label: "container", w: 240 }, { label: "image · status" }, { label: "ports", w: 150 }, { label: "cpu · mem", w: 120 }, { label: "", w: 100, align: "right" }], rows, null) }));
      }
    }
    if (!panels.length) {
      panels.push(div().mx(12).mt(12).text_color(t.dim).child(words.length
        ? `No ${filter === "all" ? "" : `${filter} `}container matches "${query.trim()}".`
        : `No ${filter === "all" ? "" : `${filter} `}container on any machine.`));
    }
    const bar = chips(t, { id: "docker-filter", selected: FILTERS.findIndex((f) => f.key === filter),
      options: FILTERS.map((f) => ({ label: f.label, count: counts[f.key] })),
      onSelect: (i, cx) => { setShared(FILTER_KEY, FILTERS[i].key); cx.notify(); } });
    return v_flex().id("docker-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar()
      .child(div().mx(12).mt(12).child(bar)).children(panels);
  },
};

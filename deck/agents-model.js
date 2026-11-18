// Pure model of Deck's Agents tab. No Herdr imports (node tests it).
// build({agents, spaces, terminals, probe, now}) -> {rows, working, top}
// probe is ctx.probe: "here" or machine name -> MachineProbe (.agents by address).
// Row: {key, app, program, state, word, color, machine, repo, branch, place, doing, history, cpu, rssKiB, age, target}.

import { providerKey } from "./swarm-model.js";

// state -> [word, theme token, sort rank]
const STATES = { blocked: ["needs you", "blocked", 0], running: ["working", "working", 1], working: ["working", "working", 1], done: ["done", "done", 2], idle: ["idle", "dim", 3] };

export const shortApp = (app) => {
  const k = providerKey(app);
  return k === "antigravity" ? "agy" : k === "claude-code" ? "claude" : k || "?";
};

// KiB -> "1.4G" / "612M"; null -> "-".
export function fmtMem(kib) {
  if (!Number.isFinite(kib)) return "-";
  return kib >= 1024 * 1024 ? `${(kib / 1024 / 1024).toFixed(1)}G` : `${Math.round(kib / 1024)}M`;
}

// ms since creation -> "<1m", "42m", "3h", "2d"; unknown -> "-".
export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const m = Math.floor(ms / 60000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export const fmtCpu = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-");

const machineOf = (address) => (address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : null);

// A parent address on the child's machine, as terminals() writes it.
export function parentOf(kid) {
  if (!kid.parent) return null;
  const machine = machineOf(kid.address);
  return kid.parent.includes("/") || !machine ? kid.parent : `${machine}/${kid.parent}`;
}

// A task is any terminal another one started (`hc run`) or one with a `task` label.
export const isTask = (t) => Boolean(t.labels?.task || t.parent);

export const providerOf = (t) => t.program?.name || t.agent || t.argv?.[0] || "?";

const TITLE_MAX = 80;
// "Review src/auth. Report with hc send…" -> "Review src/auth."
function firstSentence(text) {
  const first = text.trim().split(/\n|(?<=[.!?])\s/)[0].trim();
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

// The `task` label; else the agent's prompt (its longest argument with a space); else the name or command.
export function titleOf(t) {
  if (t.labels?.task) return t.labels.task;
  if (t.board_title) return t.board_title;
  const words = (t.argv ?? []).slice(1).filter((a) => typeof a === "string" && a.includes(" ") && !a.startsWith("-"));
  const prompt = words.sort((a, b) => b.length - a.length)[0];
  return prompt ? firstSentence(prompt) : t.name || (t.argv ?? []).join(" ") || t.address;
}

// working | blocked | idle | ... for a live task; finished | failed | stopped once it ended.
export function statusOf(task, reported) {
  if (task.state === "live") return reported.get(task.address) ?? task.status ?? "running";
  // A killed program may still exit 0 (OpenCode does); hc's reason tells. Killed after idle counts as finished.
  if (task.reason === "killed") return ["idle", "done"].includes(task.last_status) ? "finished" : "stopped";
  if (task.exit_code === 0) return "finished";
  return task.signal || task.exit_code == null ? "stopped" : "failed";
}

// What is kept of a task once its terminal is gone.
export const snapshot = (t) => ({
  address: t.address, name: t.name, labels: t.labels, program: t.program, agent: t.agent, argv: t.argv?.slice(0, 1),
  board_title: titleOf(t), parent: t.parent, created_ms: t.created_ms, last_status: t.status ?? null,
});

// A history entry from a snapshot and `hc get` facts.
export const ended = (snap, facts, now) => ({
  ...snap, state: "finished", exit_code: facts.exit_code ?? null, signal: facts.signal ?? null,
  reason: facts.reason ?? null, finished_ms: facts.finished_ms ?? now,
});

// New history: the entry first, one per address, newest `max`.
export const remember = (history, entry, max = 50) => [entry, ...history.filter((h) => h.address !== entry.address)].slice(0, max);

const ENDINGS = { finished: ["done", "done"], failed: ["failed", "ansi1"], stopped: ["stopped", "dim"] };
const dur = (ms) => (ms == null ? "-" : fmtAge(ms));

// Tasks that ended, newest first: terminals that left `live` and history entries no terminal shows.
export function finishedTasks({ terminals, history, now }) {
  const tasks = terminals.filter(isTask);
  const known = new Set(tasks.map((t) => t.address));
  return [...tasks.filter((t) => t.state !== "live"), ...history.filter((h) => !known.has(h.address))]
    .map((t) => {
      const status = statusOf(t, new Map());
      const [word, color] = ENDINGS[status] ?? ENDINGS.stopped;
      const end = t.finished_ms ?? now;
      const code = t.exit_code != null ? `exit ${t.exit_code}` : t.signal ? `signal ${t.signal}` : "";
      return { key: t.address, address: t.address, title: titleOf(t), app: shortApp(providerOf(t)), program: t.program ?? null, word, color, code, end,
        duration: t.created_ms ? dur(end - t.created_ms) : "-" };
    })
    .sort((a, b) => b.end - a.end);
}

// Remembers live tasks in `seen`; returns the [address, snapshot] pairs that left `live` and are not in `resolving`, marking them there.
export function departed(seen, resolving, live) {
  for (const t of live) seen.set(t.address, snapshot(t));
  const here = new Set(live.map((t) => t.address));
  const gone = [...seen].filter(([a]) => !here.has(a) && !resolving.has(a));
  for (const [a] of gone) resolving.add(a);
  return gone;
}

export function build({ agents, spaces, terminals, probe, now }) {
  const spaceMachine = new Map(spaces.map((s) => [s.id, s.machine ?? null]));
  const byAddress = new Map(terminals.map((t) => [t.address, t]));
  const live = terminals.filter((t) => isTask(t) && t.state === "live");
  const taskAddress = new Set(live.map((t) => t.address));
  const status = new Map(agents.map((a) => [a.address, a.status]));
  const make = (address, machine, st, extra) => {
    const t = byAddress.get(address);
    const p = probe?.[machine ?? "here"]?.agents?.[address];
    const [word, color, rank] = STATES[st] ?? [st, "dim", 4];
    const msg = t?.report?.msg;
    const task = taskAddress.has(address);
    return {
      key: address, state: st, word, color, rank, machine, repo: p?.repo ?? null, branch: p?.branch ?? null,
      doing: typeof msg === "string" ? msg : "", history: p?.history ?? [], cpu: p?.cpu ?? null, rssKiB: p?.rssKiB ?? null,
      age: (p?.created_ms ?? t?.created_ms) ? fmtAge(now - (p?.created_ms ?? t.created_ms)) : "-", created: t?.created_ms ?? 0,
      target: { terminal: address }, task, title: task ? titleOf(t) : "", parent: task ? parentOf(t) : null, depth: 0, ...extra,
    };
  };
  const rows = agents.map((a) => {
    const machine = spaceMachine.get(a.space) ?? null;
    return make(a.address, machine, a.status, {
      app: shortApp(a.app), program: a.program ?? null, place: [a.space_name, a.tab_name].filter(Boolean).join(" / "),
      space: a.space_name ?? "", tab: a.tab_name ?? "",
    });
  });
  // Task terminals that are not agents (shell helpers).
  for (const t of live) {
    if (status.has(t.address)) continue;
    rows.push(make(t.address, machineOf(t.address), statusOf(t, new Map()), {
      app: shortApp(providerOf(t)), program: t.program ?? null, place: t.labels?.where ?? "", space: t.labels?.where ?? "", tab: "",
    }));
  }
  const cmp = (x, y) => x.rank - y.rank || (x.machine ? 1 : 0) - (y.machine ? 1 : 0) || (x.machine ?? "").localeCompare(y.machine ?? "")
    || x.space.localeCompare(y.space) || x.tab.localeCompare(y.tab);
  const keys = new Set(rows.map((r) => r.key));
  const kids = new Map();
  for (const r of rows) if (r.parent && r.parent !== r.key && keys.has(r.parent)) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
  // Tasks sit under their parent row, urgent first, newest first.
  const out = [];
  const seen = new Set();
  const add = (r, depth) => {
    if (seen.has(r.key)) return;
    seen.add(r.key);
    out.push(Object.assign(r, { depth }));
    for (const k of (kids.get(r.key) ?? []).sort((x, y) => x.rank - y.rank || y.created - x.created)) add(k, depth + 1);
  };
  const isKid = (r) => r.parent && r.parent !== r.key && keys.has(r.parent);
  rows.filter((r) => !isKid(r)).sort(cmp).forEach((r) => add(r, 0));
  rows.filter((r) => !seen.has(r.key)).forEach((r) => add(r, 0)); // a parent cycle
  rows.length = 0;
  rows.push(...out);
  const byApp = new Map();
  for (const r of rows) if (r.cpu != null) byApp.set(r.app, (byApp.get(r.app) ?? 0) + r.cpu);
  const [top, total] = [...byApp].sort((a, b) => b[1] - a[1])[0] ?? [];
  return { rows, working: rows.filter((r) => r.word === "working").length, top: total > 0 ? top : null };
}

export const summary = (m) => `${m.working} working${m.top ? ` · ${m.top} uses most` : ""}`;

// Case-insensitive: every word of the query must appear in one of the row's fields.
export function filterRows(rows, query, fields = (r) => [r.key, r.app, r.repo, r.branch, r.place, r.doing, r.machine, r.title]) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = fields(r).filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const filterFinished = (list, query) => filterRows(list, query, (f) => [f.title, f.app, f.word, f.code, f.address]);

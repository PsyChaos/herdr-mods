// Pure Swarm view model. No Herdr imports; copied Pass helpers retain its MIT license.
// model(runs, live, now): merged runs, Map address -> {status, name, msg}, epoch ms
// -> {open: [{run, chef, rows}], served: [{run, key, title, count, duration, pr, target}]}.
// Rows: {key, id, title, worker: {name, provider, model, effort}, stage, state,
// color, doing: {who, msg} | null, elapsed, findings, target}. Worker metadata is raw;
// shortModel / EFFORT format it. color is a theme token (ansi1 falls back to blocked).
// chef: {address, name, msg, target} | null; name falls back to the address.
// Targets: {terminal: machine-qualified address, machine: name | null}, {url}, or null.
// Keys use "." for this machine, matching mergeBoards; served keys end in ":served".
// mergeBoards(Map machine -> board) -> {runs, stats}; addressOn(machine, terminal),
// providerKey(provider), shortModel(model), STAGES, EFFORT, duration(ms) are view helpers.

export const STAGES = ["fire", "cook", "taste", "review", "pass"];

// Live statuses that mean a helper is at the plate now. A reviewer or resolver
// that finished stays a live terminal (done / idle) and is no longer one.
const ACTIVE = new Set(["working", "blocked"]);

export const providerKey = (p) => {
  const k = String(p ?? "").toLowerCase();
  return k === "agy" || k.startsWith("antigravity") || k === "gemini" ? "antigravity" : k;
};

const SHORT = { sonnet: "son", haiku: "hai", fable: "fab" };

// "gpt-6.1-sol" -> "sol", "claude-opus-5-5" -> "opus", "claude-sonnet-5-5" -> "son".
export function shortModel(model) {
  if (!model) return "?";
  const words = String(model).toLowerCase().split(/[-_\s/]+/)
    .filter((w) => /^[a-z]/.test(w) && !/^(claude|gpt|gemini|openai|anthropic|google)$/.test(w));
  const word = words[0] ?? String(model);
  return SHORT[word] ?? word.slice(0, 5);
}

// A task's terminal as terminals() names it: remote ones carry their machine.
export const addressOn = (machine, terminal) =>
  (!terminal ? null : machine && !terminal.includes("/") ? `${machine}/${terminal}` : terminal);

// Every machine's board in one list. boards: Map machine key ("" here) ->
// parsed board.json. A run is known by the machine it was read from plus its
// id: two machines can share a hostname and a run id. `host` is only a label.
export function mergeBoards(boards) {
  const runs = [];
  const empty = (provider) => ({ provider, plates: 0, sent_back: 0, tasks: 0, retries: 0, tasted: 0 });
  const stats = new Map(["claude", "codex", "antigravity"].map((p) => [p, empty(p)]));
  const seen = new Set();
  for (const [key, board] of boards) {
    const machine = key || null;
    const host = board?.host ?? machine ?? "here";
    for (const r of board?.runs ?? []) {
      const id = `${key || "."}:${r.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      runs.push({ ...r, machine, host, key: id });
    }
    for (const s of board?.stats ?? []) {
      const k = providerKey(s.provider);
      const acc = stats.get(k) ?? empty(k);
      for (const f of ["plates", "sent_back", "tasks", "retries", "tasted"]) acc[f] += Number(s[f]) || 0;
      stats.set(k, acc);
    }
  }
  const when = (r) => Date.parse(r.created) || 0;
  const closed = (r) => (r.status === "open" ? 0 : 1);
  runs.sort((a, b) => closed(a) - closed(b) || when(b) - when(a));
  return { runs, stats: [...stats.values()] };
}

export const EFFORT = { minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhi", max: "max" };

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

const ORDER = ["needs you", "sent back", "review", "fixing", "cooking", "checked", "waiting", "plated", "dropped"];
const COLORS = { "needs you": "blocked", "sent back": "ansi1", review: "working", fixing: "working",
  cooking: "working", checked: "muted", waiting: "dim", plated: "done", dropped: "dim" };
const message = (entry) => typeof entry?.msg === "string" && entry.msg.trim() ? entry.msg : null;
const targetOn = (machine, terminal) => terminal ? { terminal, machine: machine || null } : null;

function row(task, run, live, now) {
  const machine = run.machine;
  const address = addressOn(machine, task.terminal);
  const worker = live.get(address);
  const helpers = (task.helpers ?? []).map((h) => {
    const address = addressOn(machine, h.terminal);
    return { ...h, address, live: live.get(address) };
  }).filter((h) => ACTIVE.has(h.live?.status));
  const stage = task.stage ?? "fire";
  const state = stage === "dropped" ? "dropped"
    : worker?.status === "blocked" || helpers.some((h) => h.live.status === "blocked") ? "needs you"
    : stage === "sent_back" ? "sent back"
    : helpers.some((h) => h.role === "review" && h.live.status === "working") ? "review"
    : helpers.some((h) => h.role === "resolve" && h.live.status === "working") ? "fixing"
    : worker?.status === "working" ? "cooking"
    : stage === "pass" ? "plated"
    : stage === "taste" || stage === "review" ? "checked" : "waiting";
  const speaker = helpers.find((h) => message(h.live));
  const doing = speaker ? { who: speaker.name || speaker.live.name || speaker.role, msg: message(speaker.live) }
    : message(worker) ? { who: null, msg: message(worker) } : null;
  const helperWith = (status) => helpers.find((h) => h.live.status === status)?.address;
  const terminal = (worker?.status === "blocked" ? address : null)
    ?? helperWith("blocked")
    ?? (worker?.status === "working" ? address : null)
    ?? helperWith("working")
    ?? (worker ? address : null);
  return {
    key: `${machine || "."}:${run.id}:${task.id}`,
    id: task.id, title: task.title ?? "",
    worker: { name: task.name || worker?.name || null, provider: task.provider, model: task.model, effort: task.effort },
    stage, state, color: COLORS[state], doing,
    elapsed: task.started ? duration((task.finished == null ? now : Date.parse(task.finished)) - Date.parse(task.started)) : "",
    findings: state === "sent back"
      ? (task.review?.items ?? (task.check?.problems ?? []).slice(0, 3).map((issue) => ({ severity: "check", issue }))).slice(0, 3)
      : [],
    target: targetOn(machine, terminal),
  };
}

export function model(runs, live, now) {
  const sorted = [...runs].sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
  const open = sorted.filter((r) => r.status === "open").map((run) => {
    const address = addressOn(run.machine, run.chef);
    const chef = address ? { address, name: live.get(address)?.name || address,
      msg: message(live.get(address)), target: targetOn(run.machine, address) } : null;
    const rows = (run.tasks ?? []).map((task) => row(task, run, live, now));
    rows.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || String(a.id).localeCompare(String(b.id)));
    return { run, chef, rows };
  });
  const served = sorted.filter((r) => r.status !== "open").slice(0, 5).map((run) => {
    const finished = (run.tasks ?? []).map((task) => Date.parse(task.finished)).filter(Number.isFinite);
    return { run, key: `${run.machine || "."}:${run.id}:served`, title: run.title ?? run.id,
      count: (run.tasks ?? []).length,
      duration: finished.length ? duration(Math.max(...finished) - Date.parse(run.created)) : "",
      pr: run.pr ?? null, target: run.pr ? { url: run.pr } : null };
  });
  return { open, served };
}

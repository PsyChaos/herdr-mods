// Pure model of Deck's Agents tab. No Herdr imports (node tests it).
// build({agents, spaces, terminals, probe, now}) -> {rows, working, top}
// probe is ctx.probe: "here" or machine name -> MachineProbe (.agents by address).
// Row: {key, app, program, state, word, color, machine, repo, branch, place, doing, history, cpu, rssKiB, age, target}.

import { providerKey } from "./swarm-model.js";

// state -> [word, theme token, sort rank]
const STATES = { blocked: ["needs you", "blocked", 0], working: ["working", "working", 1], done: ["done", "done", 2], idle: ["idle", "dim", 3] };

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

export function build({ agents, spaces, terminals, probe, now }) {
  const machineOf = new Map(spaces.map((s) => [s.id, s.machine ?? null]));
  const reported = new Map(terminals.map((t) => [t.address, t.report?.msg]));
  const rows = agents.map((a) => {
    const machine = machineOf.get(a.space) ?? null;
    const p = probe?.[machine ?? "here"]?.agents?.[a.address];
    const [word, color, rank] = STATES[a.status] ?? [a.status, "dim", 4];
    const msg = reported.get(a.address);
    return {
      key: a.address, app: shortApp(a.app), program: a.program ?? null, state: a.status, word, color, rank, machine,
      repo: p?.repo ?? null, branch: p?.branch ?? null, place: [a.space_name, a.tab_name].filter(Boolean).join(" / "),
      doing: typeof msg === "string" ? msg : "", history: p?.history ?? [], cpu: p?.cpu ?? null, rssKiB: p?.rssKiB ?? null,
      age: p?.created_ms ? fmtAge(now - p.created_ms) : "-", target: { terminal: a.address },
      space: a.space_name ?? "", tab: a.tab_name ?? "",
    };
  });
  rows.sort((x, y) => x.rank - y.rank || (x.machine ? 1 : 0) - (y.machine ? 1 : 0) || (x.machine ?? "").localeCompare(y.machine ?? "")
    || x.space.localeCompare(y.space) || x.tab.localeCompare(y.tab));
  const byApp = new Map();
  for (const r of rows) if (r.cpu != null) byApp.set(r.app, (byApp.get(r.app) ?? 0) + r.cpu);
  const [top, total] = [...byApp].sort((a, b) => b[1] - a[1])[0] ?? [];
  return { rows, working: rows.filter((r) => r.state === "working").length, top: total > 0 ? top : null };
}

export const summary = (m) => `${m.working} working${m.top ? ` · ${m.top} uses most` : ""}`;

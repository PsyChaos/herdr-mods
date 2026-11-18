// Pure logic of Deck's prs tab (ported from the ci mod): check states, search,
// grouping by space, finish detection for notifications, the agent message.

// One word for a run or a check: running, pass, fail, cancelled, skip.
export function stateOf(status, conclusion) {
  if (status && status !== "completed") return "running";
  switch (conclusion) {
    case "success": return "pass";
    case "failure": case "timed_out": case "startup_failure": case "action_required": return "fail";
    case "cancelled": return "cancelled";
    default: return "skip";
  }
}

// A PR's checks as one state: any failure wins, then anything still running.
export function rollup(checks) {
  const states = checks.map((c) => stateOf(c.status, c.conclusion));
  if (states.includes("fail")) return "fail";
  if (states.includes("running")) return "running";
  if (states.includes("pass")) return "pass";
  return "none";
}

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const runIdOf = (url) => url?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null;

// "job<TAB>step<TAB>2026-11-04T10:00:00.1234567Z message" -> parts, without colours.
export function parseLog(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [job, step, ...rest] = line.split("\t");
    const message = rest.length ? rest.join("\t") : line;
    return { job: rest.length ? job : null, step: rest.length ? step : null,
      text: message.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\S+Z /, "").replace(/^﻿/, "") };
  });
}

// The log's error line for a failed `gh run view`, or for an empty answer.
export function logError(code, stdout, stderr, lines) {
  if (code === 0) return lines ? null : "No failed step logs (the run may still be going).";
  const said = (stdout || stderr || "").trim().split("\n").pop();
  return /HTTP 410/.test(said) ? "GitHub no longer keeps this run's log (it expired)." : said || "gh couldn't read the log.";
}

// A message for an agent: what failed, where, and the end of its log.
export function message(log) {
  const last = [...log.lines].reverse().find((l) => l.job);
  return [
    `CI failed: ${log.what} in ${log.repo}`, log.url,
    last ? `Failed step: ${last.job} / ${last.step}` : null,
    ...(log.lines.length ? ["", "End of the log:", "", ...log.lines.map((l) => l.text)] : [log.error ? `(${log.error})` : null]),
    "", "Find the cause and fix it.",
  ].filter((l) => l !== null).join("\n");
}

// Every word of the query appears in the context or the item text.
export function hit(query, context, item) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${context} ${item}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

const prText = (p) => `#${p.number} ${p.title} ${p.branch} ${p.author} ${p.review ?? ""} ${p.draft ? "draft" : ""} ${rollup(p.checks)} ${p.checks.map((c) => c.name).join(" ")}`;
const runText = (repo, x) => `${repo.branch} ${x.workflow} ${x.title} ${stateOf(x.status, x.conclusion)}`;

// The second line of a PR row: branch, author, checks, review, age.
export function prDetail(p, now) {
  const states = p.checks.map((c) => stateOf(c.status, c.conclusion));
  const failed = p.checks.filter((_c, i) => states[i] === "fail");
  const n = (s) => states.filter((x) => x === s).length;
  const checks = !p.checks.length ? "no checks"
    : failed.length ? `failed: ${failed.map((c) => c.name).join(", ")}`
      : n("running") ? `${n("running")} of ${p.checks.length} checks running`
        : `${n("pass")} checks passed`;
  const review = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" }[p.review];
  return { failed, runId: runIdOf(failed.find((c) => runIdOf(c.url))?.url), text: [p.branch, p.author, p.draft ? "draft" : null, checks, review, ago(p.updated, now)].filter(Boolean).join(" · ") };
}

// The space a repository of a machine shows under: the best-ranked folder that led to it.
export function ownerOf(owners, machine, repo) {
  let best = null;
  for (const folder of repo.sources ?? []) {
    const o = owners.get(`${machine}|${folder}`);
    if (o && (!best || o.rank < best.rank)) best = o;
  }
  return best?.space ?? null;
}

// Panels per space (sidebar order, then "Other folders" per machine), each with repositories whose
// items match the query. results: {[machineKey]: {machine, repos}}; botsOpen: Set of "machine|repo".
// Item kinds: "pr", "run" (branch workflow run), "bots" (the folded line).
export function build({ results, spaces, owners, query = "", botsOpen = new Set(), now = Date.now() }) {
  const totals = { prs: 0, fail: 0, running: 0, found: 0, quiet: 0 };
  const groups = new Map(spaces.map((s) => [s.id, { key: s.id, space: s, machine: s.machine ?? null, repos: [] }]));
  const strays = new Map();
  for (const r of Object.values(results)) {
    for (const repo of r.repos ?? []) {
      for (const p of repo.prs) {
        totals.prs += 1;
        const s = rollup(p.checks);
        if (s === "fail") totals.fail += 1;
        if (s === "running") totals.running += 1;
      }
      const g = groups.get(ownerOf(owners, r.machine, repo));
      if (g) g.repos.push(repo);
      else {
        if (!strays.has(r.machine)) strays.set(r.machine, { key: `other|${r.machine}`, space: null, machine: r.machine, repos: [] });
        strays.get(r.machine).repos.push(repo);
      }
    }
  }
  const searching = query.trim() !== "";
  const panels = [];
  for (const g of [...groups.values(), ...strays.values()]) {
    const repos = [];
    for (const repo of g.repos) {
      const context = `${g.space?.name ?? ""} ${repo.repo} ${repo.folder} ${g.machine ?? ""}`;
      const prs = repo.prs.filter((p) => hit(query, context, prText(p)));
      // A branch with an open PR is shown through the PR.
      const runs = repo.prs.some((p) => p.branch === repo.branch) ? []
        : repo.runs.filter((x) => hit(query, context, runText(repo, x)));
      if (!prs.length && !runs.length && !(repo.error && hit(query, context, ""))) {
        if (!searching) totals.quiet += 1;
        continue;
      }
      totals.found += prs.length;
      const mk = (p) => ({ kind: "pr", key: `pr|${g.machine}|${repo.repo}|${p.number}`, repo, p, state: rollup(p.checks), ...prDetail(p, now) });
      const items = [];
      items.push(...runs.map((x) => ({ kind: "run", key: `run|${g.machine}|${repo.repo}|${x.workflow}`, repo, x, state: stateOf(x.status, x.conclusion) })));
      items.push(...prs.filter((p) => !p.bot).map(mk));
      const bots = prs.filter((p) => p.bot);
      const botKey = `${g.machine}|${repo.repo}`;
      if (searching) items.push(...bots.map(mk)); // matching bot PRs show as they are
      else if (bots.length) {
        const open = botsOpen.has(botKey);
        items.push({ kind: "bots", key: `bots|${botKey}`, botKey, open, count: bots.length, failing: bots.filter((p) => rollup(p.checks) === "fail").length,
          names: [...new Set(bots.map((p) => p.author))].join(", ") });
        if (open) items.push(...bots.map(mk));
      }
      repos.push({ repo, items });
    }
    if (repos.length) panels.push({ key: g.key, space: g.space, machine: g.machine, repos });
  }
  const rows = panels.flatMap((g) => g.repos.flatMap((r) => r.items))
    .map((i) => ({ key: i.key, target: i.kind === "bots" ? null : { url: i.kind === "pr" ? i.p.url : i.x.url } }));
  return { panels, rows, totals };
}

// Finished PRs and branch runs between two looks at one machine. seen: Map (kept by the caller),
// primed: true after the machine's first answer (which only records where things stand).
export function finishes(seen, primed, machineKey, repos) {
  const finished = [];
  const record = (key, id, state, msg) => {
    const before = seen.get(key);
    seen.set(key, { id, state });
    if (!primed || !before || state === "running" || state === "none" || state === "skip") return;
    if (before.state === "running" || before.id !== id) finished.push({ state, ...msg });
  };
  for (const repo of repos) {
    for (const p of repo.prs) {
      const failed = p.checks.filter((c) => stateOf(c.status, c.conclusion) === "fail").map((c) => c.name);
      record(`${machineKey}|${repo.repo}#${p.number}`, p.checks.map((c) => c.url).sort().join(), rollup(p.checks), {
        title: `${repo.repo} #${p.number}`, body: p.title + (failed.length ? ` · failed: ${failed.join(", ")}` : ""),
      });
    }
    for (const x of repo.runs) {
      if (repo.prs.some((p) => p.branch === repo.branch)) continue; // announced through the PR
      record(`${machineKey}|${repo.repo}|${repo.branch}|${x.workflow}`, x.id, stateOf(x.status, x.conclusion), {
        title: `${repo.repo} · ${x.workflow}`, body: `${repo.branch}: ${x.title}`,
      });
    }
  }
  return finished;
}

export const busy = (results) => Object.values(results).some((r) => (r.repos ?? []).some((repo) =>
  repo.runs.some((x) => stateOf(x.status, x.conclusion) === "running") || repo.prs.some((p) => rollup(p.checks) === "running")));

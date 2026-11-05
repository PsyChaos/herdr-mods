// What the Agent team window sends to agents (hc send: typed into the agent's
// input and submitted). Agents answer each other with herdr-team.

const MAX_PATHS = 8;

// "Codex in Vensift / 2"
export const agentName = (a) => `${a.program?.name ?? "agent"} in ${a.space_name} / ${a.tab_name}`;

// "t3n (Codex, branch feat-x, ~/x-wt)"
const member = (a, tree) => `${a.address.split("/").pop()} (${a.program?.name ?? "agent"}, branch ${tree.branch ?? "detached"}, ${tree.top})`;

const pathList = (paths) => paths.slice(0, MAX_PATHS).join(", ") + (paths.length > MAX_PATHS ? ` and ${paths.length - MAX_PATHS} more` : "");

const HOW = 'herdr-team who lists who works here, herdr-team say <address|all> "..." sends a message that '
  + "arrives in their input, herdr-team log shows what was said.";

// To one agent of a worktree whose files another worktree changes too.
export function overlapText(target, conflict) {
  const others = conflict.sides.filter((s) => !s.agents.some((a) => a.address === target.address));
  const who = others.flatMap((s) => s.agents.map((a) => member(a, s)));
  const one = conflict.paths.length === 1;
  return `[team] Heads-up: ${who.join("; ") || "another worktree"} also ${who.length > 1 ? "change" : "changes"} `
    + `${one ? "this file" : "these files"}: ${pathList(conflict.paths)}. Your branches will conflict there. `
    + `Agree with ${who.length > 1 ? "them" : "it"} who changes what before you edit ${one ? "it" : "them"} further: ${HOW}`;
}

// To one agent that shares its folder with others.
export function sharedText(target, conflict) {
  const others = conflict.agents.filter((a) => a.address !== target.address).map((a) => member(a, conflict.tree));
  return `[team] Heads-up: ${others.join("; ")} ${others.length > 1 ? "work" : "works"} in the same folder as you. `
    + "Uncommitted changes there are mixed: don't revert, stash, reset or commit files you didn't change yourself, "
    + `and tell ${others.length > 1 ? "them" : "it"} before you run anything that rewrites the working tree: ${HOW}`;
}

// What the Agent team window reads and how it groups it.
//
// PROBE runs once per machine (python3 -I -c, through `hc exec` for another
// machine) with each agent's address and folder. An agent's folder is the one
// it last ran herdr-team in (~/.local/state/herdr-team/members.json), else its
// pane's. For each folder it finds the git worktree, the
// repository it belongs to (the shared git dir, so every worktree of one
// repository lands together), the branch, the files changed and not committed,
// and the files the branch changed since it left the default branch. It also
// reads each repository's message log. It only reads.

// The log herdr-team keeps: one file per repository, in its shared git dir, so
// every worktree sees the same one and git never commits it.
export const BOARD_FILE = "herdr-team.md";

export const PROBE = String.raw`
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
MAX_FILES = 400
BOARD = sys.argv[2]
MEMBERS = os.path.expanduser("~/.local/state/herdr-team/members.json")
REPOS = os.path.expanduser("~/.local/state/herdr-team/repos.json")

def git(cwd, *args):
    try:
        r = subprocess.run(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, *args],
                           capture_output=True, text=True, timeout=15)
        return r.returncode, r.stdout
    except Exception:
        return 1, ""

def expand(path):
    return HOME + path[1:] if path == "~" or path.startswith("~/") else path

def short(path):
    return "~" + path[len(HOME):] if path == HOME or path.startswith(HOME + "/") else path

def base_of(top):
    code, out = git(top, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    if code == 0 and out.strip():
        return out.strip()
    for name in ("origin/main", "origin/master", "main", "master"):
        if git(top, "rev-parse", "--verify", "--quiet", name + "^{commit}")[0] == 0:
            return name
    return None

UNMERGED = ("UU", "AA", "DD", "AU", "UA", "DU", "UD")

def status(top):
    _, out = git(top, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    parts, files, i = out.split("\0"), [], 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        xy, path = entry[:2], entry[3:]
        if xy[0] in "RC":
            i += 1  # the old name follows
        how = ("new" if xy == "??" else "conflict" if xy in UNMERGED else "deleted" if "D" in xy
               else "renamed" if xy[0] == "R" else "changed")
        files.append({"path": path, "how": how})
    return files

def folder(cwd):
    code, top = git(expand(cwd), "rev-parse", "--show-toplevel")
    if code != 0:
        return None
    top = top.strip()
    _, common = git(top, "rev-parse", "--git-common-dir")
    common = os.path.normpath(os.path.join(top, common.strip()))
    _, branch = git(top, "branch", "--show-current")
    branch = branch.strip() or None
    base = base_of(top)
    committed, ahead = [], 0
    if base and branch and branch != base.split("/", 1)[-1]:
        code, fork = git(top, "merge-base", "HEAD", base)
        if code == 0:
            fork = fork.strip()
            _, names = git(top, "diff", "--name-only", "-z", fork, "HEAD")
            committed = [n for n in names.split("\0") if n][:MAX_FILES]
            _, count = git(top, "rev-list", "--count", fork + "..HEAD")
            ahead = int(count.strip() or 0)
    changed = status(top)
    return {"top": short(top), "common": common, "branch": branch, "base": base, "ahead": ahead,
            "changed": changed[:MAX_FILES], "more": max(0, len(changed) - MAX_FILES), "committed": committed}

def board(common):
    path = os.path.join(common, BOARD)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return {"path": path, "text": f.read()[-20000:]}
    except OSError:
        return {"path": path, "text": ""}

try:
    with open(MEMBERS, encoding="utf-8") as f:
        members = json.load(f)
except (OSError, ValueError):
    members = {}
wanted = json.loads(sys.argv[1])  # [[address, pane folder], ...]
paths = [members.get(address) or cwd for address, cwd in wanted]
with ThreadPoolExecutor(8) as pool:
    found = dict(zip([address for address, _ in wanted], pool.map(lambda p: folder(p) if p else None, paths)))
commons = {f["common"] for f in found.values() if f}
try:
    with open(REPOS, encoding="utf-8") as f:
        commons |= {c for c in json.load(f) if os.path.isdir(c)}
except (OSError, ValueError):
    pass
commons = sorted(commons)
print(json.dumps({"folders": found, "boards": {c: board(c) for c in commons}}))
`;

const baseName = (path) => path.replace(/\/+$/, "").split("/").pop() || path;

// "/home/me/x/.git" → "x"; a bare repository keeps its own name.
export const repoName = (common) => baseName(common.replace(/\/\.git\/?$/, "").replace(/\.git$/, ""));

// One letter per kind of change, for the file lists.
export const MARK = { changed: "M", new: "A", deleted: "D", renamed: "R", conflict: "U", committed: "C" };

// A worktree's files: uncommitted first, then those only its branch commits changed.
export function filesOf(tree) {
  const open = new Set(tree.changed.map((f) => f.path));
  return [...tree.changed, ...tree.committed.filter((p) => !open.has(p)).map((path) => ({ path, how: "committed" }))];
}

// Two or more agents in one folder, and files changed in more than one worktree.
function conflictsOf(trees) {
  const out = [];
  for (const tree of trees) {
    if (tree.agents.length > 1) out.push({ kind: "shared", tree, agents: tree.agents });
  }
  const where = new Map();
  for (const tree of trees) {
    for (const f of filesOf(tree)) {
      if (!where.has(f.path)) where.set(f.path, []);
      where.get(f.path).push(tree);
    }
  }
  // Files touched by the same set of worktrees go together.
  const bySides = new Map();
  for (const [path, sides] of where) {
    if (sides.length < 2) continue;
    const key = sides.map((s) => s.top).sort().join("\n");
    if (!bySides.has(key)) bySides.set(key, { kind: "overlap", sides, paths: [] });
    bySides.get(key).paths.push(path);
  }
  return [...out, ...bySides.values()];
}

// An agent's address on its own machine ("192.168.68.104/t7" → "t7").
export const localAddress = (address) => address.split("/").pop();

// rows: [{agent, machine, cwd}]; results: machine label → probe answer.
// → {repos, loose}: repositories with their worktrees, agents and warnings,
// and the agents outside any git folder (or not read yet).
export function group(rows, results, labelOf) {
  const repos = new Map();
  const loose = [];
  for (const row of rows) {
    const answer = results[labelOf(row.machine)];
    const found = answer?.folders?.[localAddress(row.agent.address)] ?? null;
    if (!found) { loose.push(row); continue; }
    const key = `${labelOf(row.machine)}|${found.common}`;
    if (!repos.has(key)) {
      repos.set(key, { key, machine: row.machine, common: found.common, name: repoName(found.common),
        board: answer.boards?.[found.common] ?? null, trees: new Map() });
    }
    const trees = repos.get(key).trees;
    if (!trees.has(found.top)) trees.set(found.top, { ...found, agents: [] });
    trees.get(found.top).agents.push(row.agent);
  }
  const list = [...repos.values()].map((repo) => {
    const trees = [...repo.trees.values()];
    return { ...repo, trees, conflicts: conflictsOf(trees) };
  });
  // Repositories with warnings first, then the busiest.
  list.sort((a, b) => (b.conflicts.length - a.conflicts.length) || (b.trees.length - a.trees.length) || a.name.localeCompare(b.name));
  return { repos: list, loose };
}

// The board's lines, newest last, without blanks.
export const boardLines = (board) => (board?.text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);

// "- 2026-11-04 20:37 t3w(claude-code) → t3x(codex): text" → its parts (older
// lines have no programs); other lines keep their text.
const LOG_LINE = /^- (\d{4}-\d\d-\d\d) (\d\d:\d\d) (\S+) → (\S+): (.*)$/;
const PARTY = /^([^()\s]+)(?:\(([^)]*)\))?$/;

const party = (token) => {
  const m = token.match(PARTY);
  return { address: m?.[1] ?? token, program: m?.[2] ?? null };
};

// The log's messages, oldest first, each with its line number.
export function parseLog(board) {
  return boardLines(board).map((raw, i) => {
    const m = raw.match(LOG_LINE);
    if (!m) return { i, date: "", time: "", from: party("?"), to: party("?"), text: raw.replace(/^- /, "") };
    return { i, date: m[1], time: m[2], from: party(m[3]), to: party(m[4]), text: m[5] };
  });
}

// Every word appears in the text (case ignored); no words match everything.
export const matches = (words, text) => words.every((w) => text.toLowerCase().includes(w));

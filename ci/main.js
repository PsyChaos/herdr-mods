// PRs & CI: the open pull requests and the latest CI runs of every GitHub
// repository open in a Herdr space, on this computer and on every connected
// machine, grouped by space, with a search and a notification when a run
// finishes.
//
// Each machine is asked with one Python script (PROBE) that gets the folders of
// that machine's spaces, finds their git repositories with a github.com origin,
// and asks that machine's `gh` (its own login) for the open PRs with their
// checks, and the latest run of each workflow on the checked-out branch. It only
// reads; nothing is written to GitHub.
// Notifications come from a second copy of this mod, the watcher: an invisible
// 2×2 kept window (props.watch) that the panel starts, so they come while the
// panel is closed and after a restart. The panel's footer turns it off and on.
// "Send to an agent" puts a failed run's message in an agent's input, unsent.
// Runs as a window: ctrl-shift-r ("mod.open:ci").

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, panes, spaces, machines, exec, hc, notify, run, theme, props, openOverlay, closeOverlay, shared, setShared, settings, window as hostWindow } from "herdr";

// The watcher's window. Herdr keeps the spec (props too) and reopens it on start.
const WATCHER = { mod: "ci", props: { watch: true }, kind: "window", key: "ci-watch", keep: true,
  frame: "none", width: 2, height: 2, at: { x: 0, y: 0 } };
// Shared {overlay, at} while the watcher runs; {off: true} once turned off.
const WATCH_KEY = "ci.watch";
// The watcher says it is alive this often; the panel restarts one quiet for longer.
const HEARTBEAT_MS = 60000;
const WATCH_STALE_MS = 3 * HEARTBEAT_MS;

const REFRESH_MS = 60000;
// While something runs, look more often so the notification comes soon after.
const BUSY_REFRESH_MS = 20000;
const LOG_LINES = 60;

const PROBE = String.raw`
import json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")

def run(argv, timeout=20):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:
        return 1, "", str(e)

def expand(path):
    return HOME + path[1:] if path == "~" or path.startswith("~/") else path

def short(path):
    return "~" + path[len(HOME):] if path == HOME or path.startswith(HOME + "/") else path

def repo_of(folder):
    code, top, _ = run(["git", "-C", expand(folder), "rev-parse", "--show-toplevel"])
    if code != 0:
        return None
    top = top.strip()
    _, url, _ = run(["git", "-C", top, "remote", "get-url", "origin"])
    m = re.search(r"github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?\s*$", url)
    if not m:
        return None
    _, branch, _ = run(["git", "-C", top, "branch", "--show-current"])
    return {"repo": m.group(1), "folder": short(top), "branch": branch.strip() or None}

PR_FIELDS = "number,title,url,headRefName,isDraft,author,updatedAt,statusCheckRollup,reviewDecision"
RUN_FIELDS = "databaseId,status,conclusion,workflowName,url,displayTitle,updatedAt,event"

def checks(rollup):
    out = []
    for c in rollup or []:
        if c.get("__typename") == "StatusContext":
            state = (c.get("state") or "").lower()
            done = state in ("success", "failure", "error")
            out.append({"name": c.get("context"), "status": "completed" if done else "in_progress",
                        "conclusion": ("failure" if state == "error" else state) if done else None,
                        "url": c.get("targetUrl")})
        else:
            out.append({"name": c.get("name"), "status": (c.get("status") or "").lower(),
                        "conclusion": (c.get("conclusion") or "").lower() or None, "url": c.get("detailsUrl")})
    return out

def load(entry):
    repo = entry["repo"]
    code, out, err = run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "30", "--json", PR_FIELDS])
    if code != 0:
        return {**entry, "error": (err.strip().splitlines() or ["gh failed"])[-1][:200], "prs": [], "runs": []}
    prs = []
    for p in json.loads(out or "[]"):
        author = p.get("author") or {}
        login = author.get("login") or ""
        prs.append({"number": p["number"], "title": p["title"], "url": p["url"], "branch": p["headRefName"],
                    "draft": p["isDraft"], "author": login.removeprefix("app/"),
                    "bot": bool(author.get("is_bot")) or login.startswith("app/") or login.endswith("[bot]"),
                    "updated": p["updatedAt"], "review": p.get("reviewDecision") or None,
                    "checks": checks(p.get("statusCheckRollup"))})
    runs = []
    if entry["branch"]:
        code, out, _ = run(["gh", "run", "list", "--repo", repo, "--branch", entry["branch"], "--limit", "10", "--json", RUN_FIELDS])
        if code == 0:
            latest = {}
            for r in json.loads(out or "[]"):
                latest.setdefault(r["workflowName"], r)
            runs = [{"id": r["databaseId"], "workflow": r["workflowName"], "status": r["status"],
                     "conclusion": r["conclusion"] or None, "url": r["url"], "title": r["displayTitle"],
                     "event": r["event"], "updated": r["updatedAt"]} for r in latest.values()]
    return {**entry, "prs": prs, "runs": runs}

code, _, _ = run(["gh", "auth", "status"])
if code != 0:
    print(json.dumps({"error": "gh is missing or not logged in here (gh auth login)"}))
    sys.exit(0)
repos = {}
for folder in json.loads(sys.argv[1]):
    r = repo_of(folder)
    if r:
        repos.setdefault(r["repo"], {**r, "sources": []})["sources"].append(folder)
with ThreadPoolExecutor(8) as pool:
    print(json.dumps({"repos": list(pool.map(load, repos.values()))}))
`;

// The failed steps' log of one run, as "job<TAB>step<TAB>time message" lines.
const LOG_SH = 'out=$(gh run view "$1" --repo "$2" --log-failed 2>&1); code=$?; printf "%s\\n" "$out" | tail -n 400; exit $code';

// Detached, so the browser it may start doesn't belong to Herdr's exec.
const OPEN_SH = 'command -v setsid >/dev/null && exec setsid -f "$0" "$1" >/dev/null 2>&1; exec "$0" "$1" >/dev/null 2>&1 &';

// How long Herdr gets to move focus to the agent's pane before the paste.
const PASTE_DELAY_MS = 250;

const COPY_SH = 'printf "%s" "$1" | { wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || pbcopy; }';

const machineLabel = (name) => name ?? "This computer";

// One word for a run or a check: running, pass, fail, cancelled, skip.
function stateOf(status, conclusion) {
  if (status && status !== "completed") return "running";
  switch (conclusion) {
    case "success": return "pass";
    case "failure": case "timed_out": case "startup_failure": case "action_required": return "fail";
    case "cancelled": return "cancelled";
    default: return "skip";
  }
}

// A PR's checks as one state: any failure wins, then anything still running.
function rollup(checks) {
  const states = checks.map((c) => stateOf(c.status, c.conclusion));
  if (states.includes("fail")) return "fail";
  if (states.includes("running")) return "running";
  if (states.includes("pass")) return "pass";
  return "none";
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const runIdOf = (url) => url?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null;

// "job<TAB>step<TAB>2026-11-04T10:00:00.1234567Z message" → its parts, without colours.
function parseLog(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [job, step, ...rest] = line.split("\t");
    const message = rest.length ? rest.join("\t") : line;
    return { job: rest.length ? job : null, step: rest.length ? step : null,
      text: message.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\S+Z /, "").replace(/^﻿/, "") };
  });
}

export default class Ci extends View {
  init(_props, cx) {
    this.watcher = Boolean(props()?.watch);
    this.results = {};
    // Last state of every PR and workflow seen, to notify when one finishes.
    this.seen = new Map();
    this.primed = new Set();
    if (this.watcher) {
      this.overlay = props()?.overlay;
      this.beat();
    } else {
      this.botsOpen = new Set();
      this.log = null;
      this.note = null;
      this.search = InputState.new({ placeholder: "Search: space, repo, #12, title, branch, author, check…" });
      this.search.on("change", (_e, cx) => cx.notify());
      this.search.focus();
      cx.timer.after(600, () => this.search.focus());
      this.handle = cx.focus_handle();
      this.startWatcher();
    }
    this.refresh(cx);
    cx.timer.every(BUSY_REFRESH_MS, (cx) => {
      const busy = this.busy();
      const stale = Object.values(this.results).some((r) => !r.at || Date.now() - r.at >= REFRESH_MS - 1000);
      if (busy || stale) this.refresh(cx);
      if (this.watcher && Date.now() - this.beatAt >= HEARTBEAT_MS) this.beat();
    });
  }

  // The watcher tells the panel it is alive, and how to close it.
  beat() {
    this.beatAt = Date.now();
    setShared(WATCH_KEY, { overlay: this.overlay, at: this.beatAt });
  }

  watchState() {
    return shared(WATCH_KEY) ?? {};
  }

  // Starts the watcher unless it runs or was turned off.
  startWatcher() {
    const w = this.watchState();
    if (w.off || (w.at && Date.now() - w.at < WATCH_STALE_MS)) return;
    openOverlay(WATCHER);
  }

  setWatching(on) {
    const w = this.watchState();
    if (on) {
      setShared(WATCH_KEY, {});
      openOverlay(WATCHER);
    } else {
      if (w.overlay) closeOverlay(w.overlay);
      setShared(WATCH_KEY, { off: true });
    }
  }

  // The folders of each machine's spaces: null is this computer. A space's
  // panes' live folders come first, its first pane's (the one the sidebar
  // shows) best, then the folder it was made in.
  // this.owners maps "machine|folder" to the best-ranked space for it.
  folders() {
    const live = new Set(machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name));
    const byMachine = new Map([[null, []]]);
    this.owners = new Map();
    const add = (machine, folder, space, rank) => {
      if (!folder || (machine && !live.has(machine))) return;
      if (!byMachine.has(machine)) byMachine.set(machine, []);
      if (!byMachine.get(machine).includes(folder)) byMachine.get(machine).push(folder);
      const key = `${machine}|${folder}`;
      const before = this.owners.get(key);
      if (!before || rank < before.rank) this.owners.set(key, { space: space.id, rank });
    };
    const all = panes();
    for (const space of spaces()) {
      const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
      const mine = all.filter((pane) => tabs.has(pane.tab) && pane.cwd);
      mine.forEach((pane, i) => add(space.machine ?? null, pane.cwd, space, i === 0 ? 0 : 1));
      add(space.machine ?? null, space.folder, space, 2);
    }
    return byMachine;
  }

  // The space a repository shows under: the best-ranked folder that led to it.
  ownerOf(machine, repo) {
    let best = null;
    for (const folder of repo.sources ?? []) {
      const owner = this.owners?.get(`${machine}|${folder}`);
      if (owner && (!best || owner.rank < best.rank)) best = owner;
    }
    return best?.space ?? null;
  }

  busy() {
    return Object.values(this.results).some((r) => (r.repos ?? []).some((repo) =>
      repo.runs.some((x) => stateOf(x.status, x.conclusion) === "running")
      || repo.prs.some((p) => rollup(p.checks) === "running")));
  }

  refresh(cx) {
    for (const [machine, folders] of this.folders()) {
      const key = machineLabel(machine);
      const current = this.results[key];
      if (current?.loading) continue;
      this.results[key] = { ...(current ?? {}), machine, loading: true };
      if (!folders.length) {
        this.results[key] = { machine, repos: [], error: null, loading: false, at: Date.now() };
        continue;
      }
      cx.spawn(async (cx) => {
        const argv = ["python3", "-I", "-c", PROBE, JSON.stringify(folders)];
        const answer = machine
          ? await hc(["exec", "--on", machine, "--", ...argv]).catch((e) => ({ code: 1, stderr: String(e) }))
          : await exec(argv[0], argv.slice(1)).catch((e) => ({ code: 1, stderr: String(e) }));
        let repos = current?.repos ?? [];
        let error = null;
        try {
          if (answer.code !== 0) throw new Error(answer.stderr?.trim() || "no answer");
          const parsed = JSON.parse(answer.stdout);
          if (parsed.error) throw new Error(parsed.error);
          repos = parsed.repos;
        } catch (e) {
          error = String(e?.message ?? e).split("\n").pop();
        }
        // Only the watcher notifies, so an open panel doesn't double them.
        if (!error && this.watcher) this.announce(key, repos);
        this.results[key] = { machine, repos, error, loading: false, at: Date.now() };
        cx.notify();
      });
    }
    cx.notify();
  }

  // Notifies once for every PR whose checks, or branch workflow whose run, just
  // finished. The first answer from a machine only records where things stand.
  announce(machineKey, repos) {
    const primed = this.primed.has(machineKey);
    const finished = [];
    const record = (key, id, state, message) => {
      const before = this.seen.get(key);
      this.seen.set(key, { id, state });
      if (!primed || !before || state === "running" || state === "none" || state === "skip") return;
      if (before.state === "running" || before.id !== id) finished.push({ state, ...message });
    };
    for (const repo of repos) {
      for (const p of repo.prs) {
        const failed = p.checks.filter((c) => stateOf(c.status, c.conclusion) === "fail").map((c) => c.name);
        record(`${machineKey}|${repo.repo}#${p.number}`, p.checks.map((c) => c.url).sort().join(), rollup(p.checks), {
          title: `${repo.repo} #${p.number}`, body: p.title + (failed.length ? ` · failed: ${failed.join(", ")}` : ""),
        });
      }
      for (const x of repo.runs) {
        // A branch with an open PR is already announced through the PR.
        if (repo.prs.some((p) => p.branch === repo.branch)) continue;
        record(`${machineKey}|${repo.repo}|${repo.branch}|${x.workflow}`, x.id, stateOf(x.status, x.conclusion), {
          title: `${repo.repo} · ${x.workflow}`, body: `${repo.branch}: ${x.title}`,
        });
      }
    }
    this.primed.add(machineKey);
    for (const f of finished) {
      const word = { pass: "passed", fail: "failed", cancelled: "was cancelled" }[f.state];
      notify({
        title: `${f.title} ${word}`, body: f.body, timeout: f.state === "fail" ? 0 : 8000,
        level: f.state === "pass" ? "success" : f.state === "fail" ? "error" : "warning",
        action: { name: "mod.open", args: { name: "ci" } },
      });
    }
  }

  openUrl(url, cx) {
    const opener = hostWindow()?.platform === "macos" ? "open" : "xdg-open";
    // A promise callback has no cx of its own: async work runs in cx.spawn.
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", OPEN_SH, opener, url]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      this.note = r.code === 0 ? null : `Couldn't open ${url}: ${(r.stderr || "").trim() || `exit ${r.code}`}`;
      cx.notify();
    });
  }

  // Shows the failed steps' log of a run below the list.
  showLog(machine, repo, runId, what, url, cx) {
    if (!runId) { this.openUrl(url, cx); return; }
    const space = this.spaceOf(machine, repo);
    this.log = { machine, repo, space, runId, what, url, lines: [], loading: true, error: null, copied: false, picking: false };
    cx.notify();
    cx.spawn(async (cx) => {
      const argv = ["sh", "-c", LOG_SH, "sh", String(runId), repo];
      const answer = machine
        ? await hc(["exec", "--on", machine, "--", ...argv]).catch((e) => ({ code: 1, stderr: String(e) }))
        : await exec(argv[0], argv.slice(1)).catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.log?.runId !== runId) return;
      const failed = answer.code !== 0;
      const lines = failed ? [] : parseLog(answer.stdout ?? "");
      const said = (answer.stdout || answer.stderr || "").trim().split("\n").pop();
      const error = failed
        ? /HTTP 410/.test(said) ? "GitHub no longer keeps this run's log (it expired)." : said || "gh couldn't read the log."
        : lines.length ? null : "No failed step logs (the run may still be going).";
      this.log = { ...this.log, loading: false, lines: lines.slice(-LOG_LINES), error };
      cx.notify();
    });
  }

  // The space a repository of a machine shows under.
  spaceOf(machine, name) {
    const repo = (this.results[machineLabel(machine)]?.repos ?? []).find((r) => r.repo === name);
    return repo ? this.ownerOf(machine, repo) : null;
  }

  // A message for an agent: what failed, where, and the end of its log.
  message(log) {
    const last = [...log.lines].reverse().find((l) => l.job);
    return [
      `CI failed: ${log.what} in ${log.repo}`, log.url,
      last ? `Failed step: ${last.job} / ${last.step}` : null,
      ...(log.lines.length ? ["", "End of the log:", "", ...log.lines.map((l) => l.text)] : [log.error ? `(${log.error})` : null]),
      "", "Find the cause and fix it.",
    ].filter((l) => l !== null).join("\n");
  }

  // Puts the message on the clipboard; `then` runs once it is there.
  copy(log, done, cx, then) {
    const text = this.message(log);
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", COPY_SH, "sh", text]).catch(() => ({ code: 1 }));
      if (r.code === 0 && then) await then(cx);
      if (this.log === log || this.log?.runId === log.runId) this.log = { ...this.log, copied: r.code === 0 ? done : "Copy failed", picking: false };
      cx.notify();
    });
  }

  copyForAgent(cx) {
    this.copy(this.log, "Copied", cx);
  }

  // Agents to offer: the repository's space first, then the rest.
  candidates(log) {
    const all = agents();
    return [...all.filter((a) => a.space === log.space), ...all.filter((a) => a.space !== log.space)];
  }

  // Into the agent's input, not sent: focus its pane and paste the clipboard.
  sendTo(agent, cx) {
    const name = `${agent.program?.name ?? "agent"} in ${agent.space_name}`;
    this.copy(this.log, `In ${name}'s input; press Enter there`, cx, async (cx) => {
      run("pane.focus", { pane: agent.pane });
      await cx.sleep(PASTE_DELAY_MS);
      run("terminal.paste");
    });
  }

  // One agent in the repository's space gets it at once; otherwise pick.
  sendToAgent(cx) {
    const log = this.log;
    const here = agents().filter((a) => a.space === log.space);
    if (here.length === 1) { this.sendTo(here[0], cx); return; }
    this.log = { ...log, picking: !log.picking };
    cx.notify();
  }

  agentPicker(t) {
    const list = this.candidates(this.log);
    if (!list.length) return div().px(10).py(4).text_size(10.5).text_color(t.dim).child("No agents are running.");
    return v_flex().flex_none().max_h(130).id("agent-pick").overflow_y_scrollbar().px(6).pb(4)
      .children(list.map((a) => h_flex().id(`agent-${a.address}`).px(6).py(2).gap(8).items_center().rounded(5)
        .cursor_pointer().text_size(11).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.sendTo(a, cx))
        .child(div().flex_none().text_color(t.foreground).child(a.program?.name ?? "agent"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${a.space_name} / ${a.tab_name} · ${a.title || a.status}`))
        .child(div().flex_none().text_size(10).text_color(a.space === this.log.space ? t.accent : t.dim).child(a.space === this.log.space ? "this space" : a.status))));
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

  colorOf(t, state) {
    return { pass: t.ansi2 ?? t.done, fail: t.blocked, running: t.ansi3 ?? t.working, cancelled: t.muted }[state] ?? t.dim;
  }

  dot(t, state) {
    return div().flex_none().w(7).h(7).rounded(4).bg(this.colorOf(t, state));
  }

  header(t, totals) {
    const overlay = props()?.overlay;
    const parts = [totals.found !== undefined ? `${totals.found} of ${totals.prs} PRs match` : `${totals.prs} open PRs`];
    if (totals.fail) parts.push(`${totals.fail} failing`);
    if (totals.running) parts.push(`${totals.running} running`);
    return h_flex()
      .h(32)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .text_size(12)
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("PRs & CI"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(parts.join(" · ")))
      .child(this.button(t, "refresh", "↻", (_e, cx) => this.refresh(cx)))
      .when(Boolean(overlay), (el) => el.child(this.button(t, "close", "✕", () => closeOverlay(overlay))));
  }

  // "Vensift/platform  ~/Desktop/Projects/Vensift/platform · 192.168.68.104"
  // "dev  ● CI  ● Images"
  repoHeader(t, machine, repo, runs) {
    const where = repo.folder;
    const showRuns = runs.length > 0 && !repo.prs.some((p) => p.branch === repo.branch);
    return v_flex()
      .px(10)
      .pl(18)
      .pr(10)
      .pt(6)
      .pb(2)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().font_semibold().text_size(11.5).text_color(t.foreground).child(repo.repo))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(where)))
      .when(Boolean(repo.error), (el) => el.child(div().truncate().text_size(10).text_color(t.blocked).child(repo.error)))
      .when(showRuns, (el) => el.child(h_flex().gap(8).items_center().flex_wrap().pt(2).text_size(10.5)
        .child(div().flex_none().text_color(t.dim).child(repo.branch))
        .children(runs.map((x) => {
          const state = stateOf(x.status, x.conclusion);
          return h_flex().id(`run-${repo.repo}-${x.id}`).flex_none().gap(4).items_center().cursor_pointer()
            .text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => state === "fail"
              ? this.showLog(machine, repo.repo, x.id, `${x.workflow} on ${repo.branch}`, x.url, cx)
              : this.openUrl(x.url, cx))
            .child(this.dot(t, state))
            .child(`${x.workflow} · ${ago(x.updated)}`);
        }))));
  }

  // "● #64 Add grounded per-change identifier extraction        Open  Log"
  //     impact-grounded-extraction · PsyChaos · 9 checks passed · 2h ago
  prRow(t, machine, repo, p) {
    const state = rollup(p.checks);
    const states = p.checks.map((c) => stateOf(c.status, c.conclusion));
    const failed = p.checks.filter((_c, i) => states[i] === "fail");
    const count = (s) => states.filter((x) => x === s).length;
    const checks = !p.checks.length ? "no checks"
      : failed.length ? `failed: ${failed.map((c) => c.name).join(", ")}`
        : count("running") ? `${count("running")} of ${p.checks.length} checks running`
          : `${count("pass")} checks passed`;
    const review = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" }[p.review];
    const detail = [p.branch, p.author, p.draft ? "draft" : null, checks, review, ago(p.updated)].filter(Boolean).join(" · ");
    const failedRun = runIdOf(failed.find((c) => runIdOf(c.url))?.url);
    const id = `${machineLabel(machine)}-${repo.repo}-${p.number}`;
    return h_flex()
      .id(`pr-${id}`)
      .pl(18)
      .pr(10)
      .py(3)
      .gap(8)
      .items_center()
      .text_size(12)
      .hover((s) => s.bg(t.hover))
      .child(this.dot(t, state))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(p.draft ? t.muted : t.foreground).child(`#${p.number} ${p.title}`))
        .child(div().truncate().text_size(10).text_color(failed.length ? t.blocked : t.dim).child(detail)))
      .child(this.button(t, `open-${id}`, "Open", (_e, cx) => this.openUrl(p.url, cx)))
      .when(Boolean(failedRun), (el) => el.child(this.button(t, `log-${id}`, "Log",
        (_e, cx) => this.showLog(machine, repo.repo, failedRun, `#${p.number} ${failed[0].name}`, p.url, cx))));
  }

  // Bot PRs (Dependabot, Renovate) fold into one line per repository.
  botRows(t, machine, repo, bots) {
    if (!bots.length) return [];
    const key = `${machineLabel(machine)}|${repo.repo}`;
    const open = this.botsOpen.has(key);
    const failing = bots.filter((p) => rollup(p.checks) === "fail").length;
    const names = [...new Set(bots.map((p) => p.author))].join(", ");
    const line = h_flex().id(`bots-${key}`).pl(18).pr(10).py(3).gap(8).items_center().cursor_pointer()
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (open) this.botsOpen.delete(key); else this.botsOpen.add(key); cx.notify(); })
      .child(div().w(7).flex_none().child(open ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate()
        .child(`${bots.length} bot PRs (${names})${failing ? ` · ${failing} failing` : ""}`));
    return [line, ...(open ? bots.map((p) => this.prRow(t, machine, repo, p)) : [])];
  }

  words() {
    return this.search.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // Every word of the search appears in the space, repository or the item.
  hit(words, context, item) {
    if (!words.length) return true;
    const text = `${context} ${item}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }

  // "● Vensift  192.168.68.104 · jsts-twins-github-graph"; a click goes to it.
  spaceHeader(t, space, machine) {
    const detail = [machine, space?.branch].filter(Boolean).join(" · ");
    return h_flex()
      .id(`space-${space?.id ?? machineLabel(machine)}`)
      .mt(8)
      .px(10)
      .py(4)
      .gap(6)
      .items_center()
      .bg(t.raised ?? t.hover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => space && run("space.select", { id: space.id }))
      .child(div().flex_none().font_semibold().text_size(12.5).text_color(t.foreground).child(space?.name ?? "Other folders"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(detail || machineLabel(machine)));
  }

  logPanel(t) {
    const log = this.log;
    const font = settings().font_family ?? "JetBrains Mono";
    const last = [...log.lines].reverse().find((l) => l.job);
    return v_flex()
      .flex_none()
      .h(250)
      .border_t(1)
      .border_color(t.border)
      .child(h_flex().h(28).flex_none().px(10).gap(6).items_center().text_size(11)
        .child(div().flex_none().font_semibold().text_color(t.foreground).child("Log"))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim)
          .child([log.what, last ? `${last.job} / ${last.step}` : null].filter(Boolean).join(" · ")))
        .when(Boolean(log.copied), (el) => el.child(div().flex_none().text_size(10).text_color(t.accent).child(log.copied)))
        .when(!log.loading, (el) => el
          .child(this.button(t, "send", log.picking ? "Send to… ▴" : "Send to an agent", (_e, cx) => this.sendToAgent(cx)))
          .child(this.button(t, "copy", "Copy", (_e, cx) => this.copyForAgent(cx))))
        .child(this.button(t, "log-web", "GitHub", (_e, cx) => this.openUrl(log.url, cx)))
        .child(this.button(t, "log-close", "✕", (_e, cx) => { this.log = null; cx.notify(); })))
      .when(log.picking, (el) => el.child(this.agentPicker(t)))
      .child(v_flex().id("log-lines").flex_1().min_h(0).px(10).pb(6).overflow_y_scrollbar()
        .font_family(font).text_size(10.5).text_color(t.muted)
        .when(log.loading, (el) => el.child(div().text_color(t.dim).child("reading the log…")))
        .when(Boolean(log.error), (el) => el.child(div().text_color(t.dim).child(log.error)))
        .children(log.lines.map((l, i) => div().id(`l-${i}`).whitespace_nowrap().truncate()
          .text_color(/error|fail|✗|exit code [1-9]/i.test(l.text) ? t.blocked : t.muted).child(l.text || " "))));
  }

  // "Notifies when a run finishes, also while closed.  Turn off"
  footer(t, quiet) {
    const off = Boolean(this.watchState().off);
    const where = `Grouped by space; click one to go there${quiet ? ` · ${quiet} repos with nothing open` : ""}.`;
    return h_flex().flex_none().px(10).py(3).gap(6).items_center().border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate()
        .child(`${where} ${off ? "Notifications are off." : "Notifies when a run finishes, also while closed."}`))
      .child(this.button(t, "watch", off ? "Turn on" : "Turn off", (_e, cx) => { this.setWatching(off); cx.notify(); }));
  }

  render(_props, cx) {
    if (this.watcher) return div().id("ci-watch");
    const t = theme();
    const totals = { prs: 0, fail: 0, running: 0 };
    const sections = [];
    const words = this.words();
    let quiet = 0;
    // Repositories under the space they belong to, in the sidebar's order.
    const groups = new Map(spaces().map((s) => [s.id, { space: s, machine: s.machine ?? null, repos: [] }]));
    const strays = new Map();
    for (const machine of this.folders().keys()) {
      const result = this.results[machineLabel(machine)] ?? { machine, loading: true };
      if (result.error) {
        sections.push(div().px(10).pt(10).text_size(10.5).text_color(t.blocked)
          .child(`${machineLabel(machine)}: ${result.error}`));
      }
      for (const repo of result.repos ?? []) {
        for (const p of repo.prs) {
          totals.prs += 1;
          const s = rollup(p.checks);
          if (s === "fail") totals.fail += 1;
          if (s === "running") totals.running += 1;
        }
        const owner = groups.get(this.ownerOf(machine, repo));
        if (owner) owner.repos.push(repo);
        else {
          if (!strays.has(machine)) strays.set(machine, { space: null, machine, repos: [] });
          strays.get(machine).repos.push(repo);
        }
      }
    }
    let found = 0;
    for (const group of [...groups.values(), ...strays.values()]) {
      const rows = [];
      for (const repo of group.repos) {
        const context = `${group.space?.name ?? ""} ${repo.repo} ${repo.folder} ${group.machine ?? ""}`;
        const prText = (p) => `#${p.number} ${p.title} ${p.branch} ${p.author} ${p.review ?? ""} ${p.draft ? "draft" : ""} ${rollup(p.checks)} ${p.checks.map((c) => c.name).join(" ")}`;
        const prs = repo.prs.filter((p) => this.hit(words, context, prText(p)));
        const runs = repo.runs.filter((x) => this.hit(words, context, `${repo.branch} ${x.workflow} ${x.title} ${stateOf(x.status, x.conclusion)}`));
        if (!prs.length && !runs.length && !(repo.error && this.hit(words, context, ""))) {
          if (!words.length) quiet += 1;
          continue;
        }
        found += prs.length;
        rows.push(this.repoHeader(t, group.machine, repo, runs));
        rows.push(...prs.filter((p) => !p.bot).map((p) => this.prRow(t, group.machine, repo, p)));
        const bots = prs.filter((p) => p.bot);
        // While searching, bot PRs that match show as they are.
        if (words.length) rows.push(...bots.map((p) => this.prRow(t, group.machine, repo, p)));
        else rows.push(...this.botRows(t, group.machine, repo, bots));
      }
      if (rows.length) sections.push(this.spaceHeader(t, group.space, group.machine), ...rows);
    }
    const loading = Object.values(this.results).some((r) => r.loading && !r.at) || !Object.keys(this.results).length;
    if (!sections.length) {
      sections.push(div().px(10).py(12).text_size(11).text_color(t.dim)
        .child(words.length ? `Nothing matches "${this.search.value().trim()}". Esc clears the search.`
          : loading ? "reading your repositories…" : "No open PRs or CI runs in the folders of your spaces."));
    }
    return v_flex()
      .id("ci")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.search.value()) this.search.set_value("");
        else if (this.log) this.log = null;
        else closeOverlay(props()?.overlay);
        cx.stop_propagation();
        cx.notify();
      })
      .size_full()
      .text_size(13)
      .child(this.header(t, words.length ? { ...totals, found } : totals))
      .child(div().flex_none().px(10).pt(8).pb(2)
        .child(Input.new(this.search).h(30).px(9).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(12).text_color(t.foreground)))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().px(10).pt(4).text_size(10.5).text_color(t.blocked).child(this.note)))
      .child(v_flex().id("ci-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(sections))
      .when(Boolean(this.log), (el) => el.child(this.logPanel(t)))
      .child(this.footer(t, quiet));
  }
}

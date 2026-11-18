// Deck's prs tab (from the ci mod): the open PRs and the latest CI runs of every GitHub repository
// open in a Herdr space, on every machine, one panel per space; a failed run's log is one click away.
// Data: one python probe per machine (git + that machine's gh), read-only, every 60 s (20 s while
// something runs). Notifications come from watch(), run by a hidden copy of Deck (see prs.md).

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, machines, exec, hc, notify, run, props, nextCommand, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { build, busy, finishes, message, parseLog, logError, outcome, prune } from "../prs-model.js";
import { panel, table, dot, rowButton, textButton, chips, logView, openUrl } from "../ui.js";

const WATCHER = { mod: "deck", props: { watch: "prs" }, kind: "window", key: "deck-ci-watch", keep: true,
  frame: "none", width: 2, height: 2, at: { x: 0, y: 0 } };
const DECK = { mod: "deck", kind: "window", key: "deck", keep: true, width: 980, height: 620 };
const WATCH_KEY = "deck.ci-watch"; // {overlay, at} while the watcher runs; {off: true} once turned off
const HEARTBEAT_MS = 60000;
const WATCH_STALE_MS = 3 * HEARTBEAT_MS;
const REFRESH_MS = 60000;
const BUSY_REFRESH_MS = 20000; // look more often while something runs, so the notification comes soon
const LOG_LINES = 60;
const PASTE_DELAY_MS = 250; // time for Herdr to move focus to the agent's pane before the paste

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
const COPY_SH = 'printf "%s" "$1" | { wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || pbcopy; }';

const keyOf = (machine) => machine ?? "here";
// UI and data live in module scope (a load in flight must not overwrite them).
const store = { results: {}, owners: new Map() };
const botsOpen = new Set();
const seen = new Map();
const primed = new Set();
const announced = {}; // machine key -> result.at already checked for finishes
let log = null; // the open log: {key, machine, repo, space, runId, what, url, lines, loading, error, copied, picking}
export const ui = { dialog: null, note: null };
const say = (text, level = "info") => { ui.note = { text, level, at: Date.now() }; };

// Folders of each machine's spaces (null = this computer): a space's panes' live folders first, the
// first pane's best, then the folder it was made in. owners maps "machine|folder" to the best space.
function folders() {
  const live = new Set(machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name));
  const byMachine = new Map([[null, []]]);
  const owners = new Map();
  const add = (machine, folder, space, rank) => {
    if (!folder || (machine && !live.has(machine))) return;
    if (!byMachine.has(machine)) byMachine.set(machine, []);
    if (!byMachine.get(machine).includes(folder)) byMachine.get(machine).push(folder);
    const k = `${machine}|${folder}`;
    const before = owners.get(k);
    if (!before || rank < before.rank) owners.set(k, { space: space.id, rank });
  };
  const all = panes();
  for (const space of spaces()) {
    const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
    const mine = all.filter((pane) => tabs.has(pane.tab) && pane.cwd);
    mine.forEach((pane, i) => add(space.machine ?? null, pane.cwd, space, i === 0 ? 0 : 1));
    add(space.machine ?? null, space.folder, space, 2);
  }
  store.owners = owners;
  return byMachine;
}

const sh = (machine, argv) => (machine
  ? hc(["exec", "--on", machine, "--", ...argv])
  : exec(argv[0], argv.slice(1))).catch((e) => ({ code: 1, stderr: String(e?.message ?? e), unreachable: true }));

// Asks every machine whose answer is older than its interval; not awaited by load().
function refresh(force = false) {
  const now = folders();
  store.results = prune(store.results, new Set([...now.keys()].map(keyOf)));
  for (const [machine, dirs] of now) {
    const key = keyOf(machine);
    const cur = store.results[key];
    if (cur?.loading) continue;
    const every = busy({ [key]: cur ?? {} }) ? BUSY_REFRESH_MS : REFRESH_MS;
    if (!force && cur?.at && Date.now() - cur.at < every - 1000) continue;
    store.results[key] = { ...(cur ?? {}), machine, loading: true };
    if (!dirs.length) { store.results[key] = { machine, repos: [], error: null, loading: false, at: Date.now() }; continue; }
    sh(machine, ["python3", "-I", "-c", PROBE, JSON.stringify(dirs)]).then((answer) => {
      if (!(key in store.results)) return; // its machine went away meanwhile
      store.results[key] = { machine, ...outcome(answer, cur?.repos), loading: false, at: Date.now() };
    });
  }
}

// One finished PR or run = one notify; only the watcher calls this.
function announce() {
  for (const [key, r] of Object.entries(store.results)) {
    if (r.error || !r.at || announced[key] === r.at) continue;
    announced[key] = r.at;
    const done = finishes(seen, primed.has(key), key, r.repos);
    primed.add(key);
    for (const f of done) {
      notify({
        title: `${f.title} ${{ pass: "passed", fail: "failed", cancelled: "was cancelled" }[f.state]}`, body: f.body,
        timeout: f.state === "fail" ? 0 : 8000, level: f.state === "pass" ? "success" : f.state === "fail" ? "error" : "warning",
        action: { name: "deck.prs" }, // reaches the watcher's nextCommand(), see watch()
      });
    }
  }
}

// First run takes over the old ci mod's choice.
function watchState() {
  let w = shared(WATCH_KEY);
  if (w === undefined || w === null) {
    w = shared("ci.watch")?.off ? { off: true } : {};
    if (w.off) setShared(WATCH_KEY, w);
  }
  return w;
}

function ensureWatcher() {
  const w = watchState();
  if (w.off || (w.at && Date.now() - w.at < WATCH_STALE_MS)) return;
  openOverlay(WATCHER);
}

function setWatching(on) {
  const w = watchState();
  if (on) { setShared(WATCH_KEY, {}); openOverlay(WATCHER); }
  else { if (w.overlay) closeOverlay(w.overlay); setShared(WATCH_KEY, { off: true }); }
}

const model = (() => {
  let memo = { state: null, query: null, bots: "", at: 0, value: null };
  return (state, query = "") => {
    const now = Date.now();
    const bots = [...botsOpen].join("\n"); // a fold toggle must show at once
    if (memo.state !== state || memo.query !== query || memo.bots !== bots || now - memo.at > 100) {
      memo = { state, query, bots, at: now, value: build({ results: state.results, spaces: spaces(), owners: state.owners, query, botsOpen, now }) };
    }
    return memo.value;
  };
})();

const dotColor = (t, state) => ({ pass: t.done, fail: t.ansi1, running: t.working, cancelled: t.muted }[state] ?? t.dim);

// Shows the failed steps' log of a run under its row.
function showLog(key, machine, repo, space, runId, what, url, cx) {
  if (log?.key === key) { log = null; return void cx.notify(); } // second press closes
  const mine = { key, machine, repo, space, runId, what, url, lines: [], loading: true, error: null, copied: "", picking: false };
  log = mine;
  cx.notify();
  cx.spawn(async (cx) => {
    const a = await sh(machine, ["sh", "-c", LOG_SH, "sh", String(runId), repo]);
    if (log !== mine) return;
    const lines = a.code !== 0 ? [] : parseLog(a.stdout ?? "");
    log = { ...mine, loading: false, lines: lines.slice(-LOG_LINES), error: logError(a.code, a.stdout, a.stderr, lines.length) };
    cx.notify();
  });
}

// Puts the message on the clipboard; `then` runs once it is there.
function copy(done, cx, then) {
  const mine = log;
  cx.spawn(async (cx) => {
    const r = await exec("sh", ["-c", COPY_SH, "sh", message(mine)]).catch(() => ({ code: 1 }));
    if (r.code === 0 && then) await then(cx);
    if (log === mine) log = { ...mine, copied: r.code === 0 ? done : "Copy failed", picking: false };
    if (r.code !== 0) say("Copy failed (no wl-copy, xclip or pbcopy?)", "error"); else say(done, "ok");
    cx.notify();
  });
}

// Agents to offer: the repository's space first.
const candidates = () => [...agents().filter((a) => a.space === log.space), ...agents().filter((a) => a.space !== log.space)];

// Into the agent's input, not sent: focus its pane and paste the clipboard.
function sendTo(agent, cx) {
  copy(`In ${agent.program?.name ?? "agent"} in ${agent.space_name}'s input; press Enter there`, cx, async (cx) => {
    run("pane.focus", { pane: agent.pane });
    await cx.sleep(PASTE_DELAY_MS);
    run("terminal.paste");
  });
}

function sendToAgent(cx) {
  const here = agents().filter((a) => a.space === log.space);
  if (here.length === 1) return sendTo(here[0], cx);
  log = { ...log, picking: !log.picking };
  cx.notify();
}

function logBox(t) {
  const last = [...log.lines].reverse().find((l) => l.job);
  const list = log.picking ? candidates() : [];
  return v_flex().gap(6).pl(16).pr(10).py(6)
    .child(h_flex().gap(8).items_center().text_size(11)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child([log.what, last ? `${last.job} / ${last.step}` : null].filter(Boolean).join(" · ")))
      .when(Boolean(log.copied), (el) => el.child(div().flex_none().truncate().text_color(t.ansi4).child(log.copied)))
      .when(!log.loading, (el) => el
        .child(textButton(t, { id: "log-send", label: log.picking ? "Send to… ▴" : "Send to an agent", onPress: (cx) => sendToAgent(cx) }))
        .child(textButton(t, { id: "log-copy", label: "Copy", onPress: (cx) => copy("Copied", cx) }))))
    .when(log.picking, (el) => el.child(list.length
      ? chips(t, { id: "log-agents", selected: -1, onSelect: (i, cx) => sendTo(list[i], cx),
        options: list.map((a) => ({ label: `${a.program?.name ?? "agent"} · ${a.space_name}${a.space === log.space ? " (this space)" : ""}` })) })
      : div().text_color(t.dim).child("No agents are running.")))
    .child(logView(t, log.loading ? ["reading the log…"] : log.error ? [log.error, ...log.lines.map((l) => l.text)] : log.lines.map((l) => l.text), { height: 180 }));
}

function itemRow(t, g, it, pick) {
  const loading = (key) => log?.key === key;
  if (it.kind === "bots") {
    return { key: it.key, cells: [div().text_color(t.muted).child(it.open ? "▾" : "▸"),
      div().text_color(t.muted).child(`${it.count} bot PRs (${it.names})`), it.failing ? `${it.failing} failing` : "", ""],
      onClick: (_e, cx) => { if (it.open) botsOpen.delete(it.botKey); else botsOpen.add(it.botKey); cx.notify(); } };
  }
  const run_ = it.kind === "run";
  const url = run_ ? it.x.url : it.p.url;
  const failedRun = run_ ? (it.state === "fail" ? it.x.id : null) : it.runId;
  const id = it.key.replace(/[^\w-]/g, "_");
  const what = run_ ? `${it.x.workflow} on ${it.repo.branch}` : `#${it.p.number} ${it.failed[0]?.name}`;
  const space = g.space?.id ?? null;
  return {
    key: it.key,
    cells: [dot(t, dotColor(t, it.state)),
      run_ ? `${it.repo.branch} · ${it.x.workflow}` : div().truncate().text_color(it.p.draft ? t.muted : t.foreground).child(`#${it.p.number} ${it.p.title}`),
      div().truncate().text_size(10).text_color(!run_ && it.failed.length ? t.ansi1 : t.dim).child(run_ ? it.x.title : it.text),
      h_flex().gap(2).justify_end()
        .child(rowButton(t, { id: `open-${id}`, icon: "external-link", tooltip: "Open on GitHub", onPress: () => openUrl(url) }))
        .child(rowButton(t, { id: `gh-${id}`, icon: "github", tooltip: `${it.repo.repo} on GitHub`, onPress: () => openUrl(`https://github.com/${it.repo.repo}`) }))
        .child(rowButton(t, { id: `log-${id}`, icon: "scroll-text", tooltip: failedRun ? "Show the failed log" : "No failed run", disabled: !failedRun,
          color: loading(it.key) ? t.ansi4 : t.dim, onPress: (cx) => showLog(it.key, g.machine, it.repo.repo, space, failedRun, what, url, cx) }))],
    under: loading(it.key) ? logBox(t) : null,
    onClick: (_e, cx) => pick(it.key, cx),
  };
}

const COLUMNS = [{ label: "", w: 10 }, { label: "pr / run" }, { label: "state" }, { label: "", w: 78, align: "right" }];

export function watch(cx) {
  const overlay = props()?.overlay;
  let beatAt = 0;
  const tick = () => {
    refresh();
    announce();
    if (Date.now() - beatAt >= HEARTBEAT_MS) { beatAt = Date.now(); setShared(WATCH_KEY, { overlay, at: beatAt }); }
  };
  tick();
  cx.timer.every(BUSY_REFRESH_MS, tick);
  // The notification's action is the mod command "deck.prs": open Deck on this tab. openOverlay
  // (unlike mod.open) never toggles; the same key "deck" reuses a window that is already open.
  cx.spawn(async () => {
    for (;;) {
      if ((await nextCommand()) !== "prs") continue;
      setShared("deck.tab", { id: "prs", at: Date.now() });
      openOverlay(DECK);
    }
  });
}

export default {
  id: "prs",
  label: "prs",
  icon: "git-pull-request",
  ui,
  watch,

  async load() {
    if (!props()?.watch) ensureWatcher();
    refresh(); // not awaited: the tick never waits for gh
    const machines_ = {};
    for (const [k, r] of Object.entries(store.results)) if (r.unreachable) machines_[k] = "error"; else machines_[k] = "ok";
    return { state: store, machines: machines_ };
  },

  count: (state) => (state ? model(state).totals.prs : 0),
  blocked: (state) => (state ? model(state).totals.fail > 0 : false),
  rows: (state, _probe, query) => (state ? model(state, query).rows : []),

  view(state, sel, cx, pick, { t, query }) {
    const body = v_flex().id("prs-body").flex_1().min_h(0).overflow_y_scrollbar().pb(12);
    if (!state) return body.child(panel(t, { id: "prs", icon: "git-pull-request", title: "prs", body: div().text_color(t.dim).child("reading your repositories…") }));
    const m = model(state, query);
    const errors = Object.values(state.results).filter((r) => r.error);
    const loading = Object.values(state.results).some((r) => r.loading && !r.at) || !Object.keys(state.results).length;
    const { totals } = m;
    const head = [query.trim() ? `${totals.found} of ${totals.prs} PRs match` : `${totals.prs} open PRs`,
      totals.fail ? `${totals.fail} failing` : null, totals.running ? `${totals.running} running` : null].filter(Boolean).join(" · ");
    for (const g of m.panels) {
      const rows = [];
      body.child(panel(t, { id: `prs-${g.key}`, icon: "git-pull-request", title: g.space?.name ?? "Other folders",
        right: [g.machine, g.space?.branch].filter(Boolean).join(" · "),
        body: [
          g.space ? h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(head))
            .child(rowButton(t, { id: `space-${g.key}`, icon: "layers", tooltip: "Go to this space", onPress: () => run("space.select", { id: g.space.id }) })) : null,
          ...g.repos.map((r) => v_flex().gap(2)
            .child(h_flex().gap(8).px(10).items_center().text_size(11)
              .child(div().flex_none().font_semibold().text_color(t.foreground).child(r.repo.repo))
              .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.repo.folder)))
            .when(Boolean(r.repo.error), (el) => el.child(div().px(10).truncate().text_color(t.ansi1).child(r.repo.error)))
            .child(table(t, COLUMNS, r.items.map((it) => itemRow(t, g, it, pick)), sel))),
        ] }));
    }
    for (const r of errors) body.child(div().mx(12).mt(12).text_size(11).text_color(t.ansi1).child(`${r.machine ?? "This computer"}: ${r.error}`));
    if (!m.panels.length) {
      body.child(panel(t, { id: "prs-empty", icon: "git-pull-request", title: "prs", body: div().text_color(t.dim)
        .child(query.trim() ? `Nothing matches "${query.trim()}". Esc clears the search.` : loading ? "reading your repositories…" : "No open PRs or CI runs in the folders of your spaces.") }));
    }
    const off = Boolean(watchState().off);
    return body.child(panel(t, { id: "prs-notify", icon: "git-pull-request", title: "notifications", body: h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(
        `${off ? "Notifications are off." : "Notifies when a run finishes, also while Deck is closed."}${totals.quiet ? ` ${totals.quiet} repos with nothing open.` : ""}`))
      .child(textButton(t, { id: "prs-watch", label: off ? "Notifications on" : "Notifications off", onPress: (cx) => { setWatching(off); cx.notify(); } })) }));
  },
};

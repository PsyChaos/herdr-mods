# Deck: every panel under one roof

**Status:** Approved (EGM review: design + readiness, findings resolved)
**Date:** 2026-11-18

## Overview

Deck (`docs/designs/deck.md`, `docs/designs/deck-look.md`) has three tabs:
Overview, Agents, Swarm. The repository still ships seven separate panel mods,
each its own window with its own look and key: task-board, usage-board,
machines, ports, docker, ci and team. The user asked for all of them in one
console. This change moves every panel into Deck as a tab (or into an existing
tab where it is the same subject), in Deck's look, and deletes the old panel
mods.

Tool mods that are not panels stay: `browser` (a page in a pane), `attach`
(files into an agent's input) and `palette-plus` (command palette).

## The Problem

Seven windows, seven keys, seven looks. Machines repeats half of Overview;
task-board repeats half of Agents. Watching the herd still means juggling
windows, which Deck was built to end.

## Goals

- One window, Ctrl+Shift+I, with these tabs (keys `1`..`8`):

  | # | tab | icon | from | old cadence kept |
  | --- | --- | --- | --- | --- |
  | 1 | overview | gauge | Overview + **machines** | probe 5 s; machines extras 10 s |
  | 2 | agents | bot | Agents + **task-board** | live |
  | 3 | swarm | layers | Swarm | 4 s |
  | 4 | team | users | **team** | 8 s |
  | 5 | usage | activity | **usage-board** | 120 s |
  | 6 | prs | git-pull-request | **ci** | 60 s, 20 s while something runs |
  | 7 | ports | plug | **ports** | 10 s |
  | 8 | docker | container | **docker** | 10 s |

- Every action of the old panels keeps working from its tab, with the same
  checks and confirmations (listed per tab below). Nothing new is added.
- CI notifications keep working while Deck is closed.
- `/` search filters every tab except Overview, with each old mod's own
  matching words (split on whitespace, every word must match).
- Deck opens on the last tab used.
- The old panel mods, their keys and README rows are removed.

## Non-Goals

- New features (Overview gets no kill button; machines had none).
- The docks of task-board and usage-board (`dock.js`): unused in the user's
  layouts; they go with their mods.
- Pass (`herdr-swarm/mods/pass`): another repository.
- Direct keys per panel (ctrl-shift-r/m/y/s/d/g/j): removed with the mods;
  inside Deck `1`..`8` pick a tab. Accepted regression.

## Technical Plan

### T0: frame contract (`deck/main.js`, `deck/ui.js`, `deck/RECIPE.md`, icons, stubs)

**Tab interface** (current one plus `ui`), written into RECIPE.md:

```js
export default {
  id, label, icon,                       // icon: a file name in deck/icons/ without .svg
  load({machines, state, board, probe}), // -> Promise<{state, machines: {name: "ok"|"error"}}>
  count(state, probe), blocked(state, probe), rows(state, probe, query),
  view(state, sel, cx, pick, {range, probe, t, query}),
  ui,                                    // optional module-scope object, see below
}
```

- **Per-tab loading.** `main.js` keeps `this.loading[tab.id]`; each tab's
  `load` runs on its own, its result is stored and `cx.notify()` called as
  soon as it resolves. A slow tab never delays another. Deck still calls
  `load` every 4 s (`TICK_MS`); a tab with a slower cadence returns its cached
  state until its own interval (a constant in its file) has passed, and a
  slow fetch runs in the background (module state) while `load` returns the
  cache at once.
- **Machine chips.** A tab reports `"error"` for a machine only when it
  cannot reach it (exec rejects). Tool problems (docker not installed, gh not
  logged in, a broken usage script) show inside the tab, not on the chip.
- **UI state lives in module scope**, never in what `load` returns (a load in
  flight would overwrite it). A tab may export `ui`:
  - `ui.dialog`: `null` or `{title, lines: [string], action, destructive,
    onConfirm(cx), onCancel(cx)}`. Deck draws `confirm(t, ui.dialog)` over the
    tab body, routes Enter to `onConfirm(cx)` and Escape to `onCancel(cx)`
    (each sets `ui.dialog = null` itself), swallows other keys, then
    `cx.notify()`.
  - `ui.note`: `null` or `{text, level: "info"|"ok"|"warn"|"error", at}`.
    Deck shows it as one line at the bottom of the tab for 8 s (`error`
    until the next note).
  - `ui.query`: when set by another tab (see Overview → docker), Deck copies
    it into its search field once and clears it.
- **Opening on a tab.** On `init`, Deck reads `shared("deck.tab")`
  (`{id, at}`): when `at` is under 10 s old it opens that tab, else the last
  tab used (module scope). Other code asks for a tab with
  `setShared("deck.tab", {id, at: Date.now()})`.
- **The watcher branch.** First lines of `init`: `if (props()?.watch) {
  TABS.find((x) => x.id === props().watch)?.watch?.(cx); return; }`; first
  line of `render`: `if (props()?.watch) return div().id("deck-watch");`.
  Nothing else (no tick, no probe) runs in a watcher copy.
- **Opening URLs.** `go({url})` uses ci's `OPEN_SH` (detached `setsid`
  opener, so it cannot hang and uses your own browser login); `ui.js`
  exports it as `openUrl(url)` for tabs.
- Stub files `tabs/{team,usage,prs,ports,docker}.js`: a panel "coming",
  `count` 0, `load` returns `{state: null, machines: {}}`.
- Tab strip fits 8 tabs at 980 px.
- Test loop becomes `find deck -name '*.test.mjs' | while read f; do node "$f" || exit 1; done`.
- RECIPE.md gets the interface above and links each tab's own
  `deck/tabs/<id>.md` (written by that tab's task).

**`ui.js` additions** (herdwatch style, from
`/tmp/claude-1000/-home-heisenberg-Desktop-Projects-omarchy/d103c7b8-3995-4141-aaba-ce5fabaa3d03/scratchpad/hwsrc/mods/herdwatch/views/widgets.js`,
colors from tokens):

```js
rowButton(t, {id, icon, tooltip, color = t.dim, hover = t.foreground, disabled = false, onPress})  // 18x18, icon 11
textButton(t, {id, label, primary = false, destructive = false, disabled = false, onPress})       // h 22, px 8
chips(t, {id, options: [{label, count}], selected, onSelect})   // index-based, like segmented
confirm(t, {title, lines, action, destructive = true})          // panel, two textButtons; keys via Deck
logView(t, lines, {height = 220})                               // mono, scrollable
note(t, {text, level})                                          // one line, color by level
openUrl(url)                                                    // detached opener, see above
```

**Icons.** T0 copies these from herdwatch `icons/ui` (Lucide): container,
plug, activity, trash-2, external-link, square-x, archive, file-diff, history.
Other icons a tab needs, each task adds itself as `deck/icons/<lucide-name>.svg`
copied unchanged from Lucide (https://lucide.dev, license already in
`LICENSES.md`); identical files from two branches merge cleanly.

### Per tab (T1..T7)

Each task ports its old mod's data code (commands, parsing, caching,
cadence) and every action listed, redraws with `ui.js` (`panel` per group,
`table` rows, `rowButton`s at row end, `chips` for filters, `ui.dialog` for
confirmations, `ui.note` for results), drops the old header/search/footer,
moves pure logic into `deck/<tab>-model.js` with a **new** node test, and
writes `deck/tabs/<tab>.md` (what it shows, data, actions). It leaves the old
mod folder untouched.

- **T1 overview + machines.** Per machine panel adds: a `procs` block (the
  top 6 processes machines showed: name, cpu, mem; no actions), disks `/`,
  `$HOME` and `/var/lib/docker` as machines read them (one meter each, deduped
  by filesystem), swap, and a docker line with machines' breakdown (running;
  unhealthy, failed and restarting in `ansi1`). Machines' extra reads run in
  a separate `exec` every 10 s with machines' 8 s timeout (docker counts via
  `timeout 2 docker ps -a …`), never inside Deck's 3 s `PROBE`. "Open in
  Docker": sets `docker.ui.query = <machine name>` and switches to the docker
  tab (`{tab: "docker"}` target). Owns `deck/tabs/overview.js`,
  `deck/machines-model.js` (+test), `deck/tabs/overview.md`.
- **T2 agents + task-board.** Task rows come from `terminals()`: any terminal
  with a `parent` or a `task` label (shell helpers included), shown indented
  under their parent row with the task label, provider glyph, duration.
  Finished tasks: task-board's history in `shared("task-board.finished")`
  (same key, keeps 50, so existing history carries over), in a `finished`
  panel (newest 10 shown; exit code, how it ended, duration). Actions: jump to
  a task's terminal; "Clear" (`textButton`, `ui.dialog`) clears the history
  and `hc rm`s each finished task, as task-board did. Owns
  `deck/tabs/agents.js`, `deck/agents-model.js` (+test), `deck/tabs/agents.md`.
- **T3 team.** `chips` agents / messages (team's two views). Agents view:
  repositories and worktrees with their agents, changed files ("N more
  files" expands), clashes with "Tell them" (`textButton`), "Introduce".
  Messages view: team's two-column inbox (projects, messages) with unread
  counts from `shared("team.read")`, mark-read after 8 s on screen, "Clear
  project" (`ui.dialog`, runs `: > log` as team did). `blocked` = any
  unread. Search matches team's fields. 8 s cadence. Moves `team/inbox.js`,
  `team/inbox-view.js`, `team/messages.js`, `team/model.js` to
  `deck/team/` (imports fixed), new `deck/team/model.test.mjs`. `herdr-team`
  (the CLI, copied to `~/.local/bin`) stays at `team/herdr-team`. Owns
  `deck/tabs/team.js`, `deck/team/`, `deck/tabs/team.md`.
- **T4 usage.** One panel per machine; a row per provider with every entry of
  its `windows[]` as a `meter` + percent + reset time, `totals[]` (no-limit
  providers such as opencode: today/week tokens), `skip: true` providers
  hidden, "N ago" when a reading is stale, errors in the row. 120 s cadence
  plus a refresh `rowButton` in the panel title row. Readers move unchanged
  from `usage-board/sources/` to `deck/usage/sources/` with
  `usage-board/CONTRACT.md` → `deck/usage/CONTRACT.md`; `SOURCES =
  "mods/deck/usage/sources"`. Owns `deck/tabs/usage.js`,
  `deck/usage-model.js` (+test), `deck/usage/`, `deck/tabs/usage.md`.
- **T5 prs (ci).** Panel per space (title click: `space.select`), rows per
  PR and per branch run with a state dot (failing `ansi1`, running
  `working`, passed `done`), bot PRs folded under one row as ci did. Row
  buttons: open (`openUrl`), GitHub (`openUrl` of the repo), log (`logView`
  under the row: `gh run view --log-failed`, last 60 lines, 410 = expired),
  copy (the agent message, `wl-copy`/`xclip`/`pbcopy`), send to an agent
  (ci's agent picker as a `chips` row under the log; puts the message in the
  input without sending). Search matches ci's fields. Cadence 60 s / 20 s.
  Watcher: `export function watch(cx)` in `tabs/prs.js` runs only the prs
  poll and `notify`, heartbeat `{overlay, at}` every 60 s to
  `shared("deck.ci-watch")`; the prs tab starts a watcher (as ci's
  `startWatcher`: a kept frameless 2x2 window at the top left, key
  `deck-ci-watch`, `props: {watch: "prs"}`) when the heartbeat is older than
  3 min and notifications are on. On/off: a `textButton` "Notifications
  on/off" in a footer panel, stored as `shared("deck.ci-watch").off`; first
  run copies `off` from `shared("ci.watch")`. Notify action:
  `setShared("deck.tab", {id: "prs", at})` then `openOverlay` of Deck's own
  window spec (not `mod.open`, which toggles). Owns `deck/tabs/prs.js`,
  `deck/prs-model.js` (+test), `deck/tabs/prs.md`. Does **not** touch
  `main.js` (T0 wrote the branch).
- **T6 ports.** Panel per machine; rows port, program or container,
  terminal. Row buttons: open in the browser mod (through that machine), "My
  browser" (another machine's port through an ssh tunnel run as a Herdr
  terminal, found again from `terminals()` labels), "Close tunnel", go to
  terminal, stop (`ui.dialog`; before `kill` re-checks with `ss sport` that
  the pid still holds the port; after 2.5 s a "Still listening" note and a
  "Force stop (kill -9)" dialog). `chips` "common / show all" (system ports
  and ports above 32768). Enter on the search opens the first matching port.
  10 s cadence. Owns `deck/tabs/ports.js`, `deck/ports-model.js` (+test),
  `deck/tabs/ports.md`.
- **T7 docker.** Panel per machine and compose project; `chips` all / running
  / stopped with counts; row buttons start, stop, restart (pending lock as
  docker did), logs and shell (open a Herdr terminal on that machine running
  `docker logs -f` / `docker exec -it … sh`, note "Opened … in a pane").
  "docker isn't installed here" shows inside the machine panel. 10 s cadence;
  `docker stats` with its 6 s limit in the background. Reads `ui.query` set
  by Overview. Moves `docker/model.js` to `deck/docker-model.js` with a new
  test (`passes`, `matches`, `projects`, `isUp`). Owns `deck/tabs/docker.js`,
  `deck/docker-model.js` (+test), `deck/tabs/docker.md`.

### After integration (chef)

1. On this machine, close the old CI watcher before deleting `ci/`: the
   overlay id saved in `shared("ci.watch").overlay`, with
   `herdr-app do overlay.close {"id": ...}`.
2. Delete `task-board/`, `usage-board/`, `machines/`, `ports/`, `docker/`,
   `ci/`, and from `team/` everything except `herdr-team` and the part of its
   RECIPE about the CLI; README rows, install lines and keys updated.
3. Remove the installed copies and their keys from
   `~/.config/herdr-app/keys.json`; usage-board's installed copy only after
   herdr-swarm#11 (Deck's usage readers path with fallback) is merged.

## Risks

- **herdr-swarm reads usage readers** from
  `~/.config/herdr-app/mods/usage-board/sources` (`config/routing.toml:76`).
  herdr-swarm#11 changes the default to `mods/deck/usage/sources` and falls
  back to the old path, so 105 keeps working until it updates.
- **Two overlay copies of Deck** (window and CI watcher) may share module
  scope. The watcher touches only prs state and `notify`; if scope is shared
  the prs cache is shared too, which is harmless.

## Alternatives Considered

- **Keep the panels, add a launcher tab in Deck.** Same juggling. Rejected.
- **Mount the old mods' views inside Deck.** Herdr cannot mount one mod's
  view in another's. Rejected.
- **Put docker counts into Deck's shared probe.** A stuck dockerd would time
  out the whole probe and gap every chart. Rejected: separate 10 s read.

## Detailed Implementation Plan

T0 first; then T1..T7 in parallel (3 live workers at a time), each owning
only its files listed above, all `--after T0`.

### Verification

- `find deck -name '*.test.mjs' | while read f; do node "$f" || exit 1; done`
- `herdr-app check` of the installed Deck; `herdr-app shot` of each tab with
  real data on this machine.
- Each action tried once on a harmless target: a test container, a
  `python3 -m http.server` port, a passing CI run's log, a team message.

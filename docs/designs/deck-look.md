# Deck: the herdwatch look, Overview and Agents tabs

**Status:** Approved (EGM review: design + readiness, findings resolved)
**Date:** 2026-11-18

## Overview

Deck v1 (`docs/designs/deck.md`) works but looks plain: proportional text,
flat boxes, one Swarm tab that is empty between runs. The user pointed at
[herdwatch](https://github.com/bryan-duarte/herdwatch) (MIT) as the look they
want. This change gives Deck that look and two new tabs:

- **Overview**: per machine, CPU (per-core cells, meter, history chart),
  memory (meter, history chart, swap), disk and network.
- **Agents**: every agent terminal on every machine: state, repo and branch,
  what it is doing now, CPU and memory of its process tree with a sparkline,
  age.
- **Swarm**: the existing tab, restyled; when no run is open it shows the
  served (closed) runs instead of an empty page.

## The Problem

Screenshot 2026-11-18: Deck opens to a header, one `swarm 0` tab and "No swarm
runs." in the middle of an empty 980x620 window. Nothing tells the user what
the machines or the agents are doing outside a swarm run, and the text,
spacing and boxes look like a generic dialog, not a monitor.

## Goals

- Deck reads like herdwatch: monospace everywhere, panels with the title cut
  into the top border ("fieldset" edge), a header with machine chips and a
  2m/5m/10m range control, a tab strip with icon, label and count, segmented
  meters, history charts and sparklines.
- Overview and Agents show real numbers from the second sample on (the first
  has no CPU baseline), on this machine and every reachable machine.
- Swarm is never an empty page: with no open run it shows the served box.
- Colors come from the Herdr theme (`theme()` tokens and `ansi0..15`), so the
  look follows the user's theme; no fixed palette.
- Nothing samples while the window is closed (as today). History lives in
  module scope but is cleared on every open (2026-11-19, the user's choice:
  gaps for the closed time looked broken), so charts start empty and fill
  from the right.
  Accepted.

## Non-Goals

- herdwatch's actions (kill, pin, open port, delete worktree, docker prune)
  and its ports/worktrees/docker/procs views. Those come with the later tab
  PRs (ports, docker), not here.
- SSH host lists: Deck uses Herdr's own machines (`machines()`, `exec` with
  `on`), not `hosts.conf`.
- macOS probes: both machines are Linux.
- GPU, per-disk I/O rates.

## Technical Plan

### Look (`ui.js`)

Ported from herdwatch's `views/widgets.js` and `views/charts.js` (MIT; the
license notice goes into `deck/LICENSES.md` with Lucide's for the icons), but
every color is a theme token instead of herdwatch's Tokyo Night palette:

| herdwatch | Deck token |
| --- | --- |
| background / backgroundDark | `background` / `canvas` |
| highlight | `hover` |
| border | `border` |
| comment / dim | `dim` / `muted` |
| foreground | `foreground` |
| green, yellow, red | `ansi2`, `ansi3`, `ansi1` |
| blue, cyan, magenta | `ansi4`, `ansi6`, `ansi5` |
| teal / orange | `ansi14` / `ansi11` |

Gradients are **stepped**, not mixed (theme colors may be `#rgb`,
`#rrggbbaa` or names): `band(colors, percent)` returns `colors[0]` below 60 %,
`colors[1]` below 85 %, else `colors[2]`. `GRADIENT = {cpu: [ansi2, ansi3,
ansi1], mem: [ansi6, ansi4, ansi5], disk: [ansi14, ansi11, ansi1]}`, keys of
`t`.

Exact exports of `ui.js` (every one takes the theme `t` first, returns an
element; T2 and T3 only consume these, they add no private copies):

```js
mono()                                    // settings().font_family ?? "JetBrains Mono"
icon(t, name, color = t.dim, size = 12)   // svg("mods/deck/icons/<name>.svg")
dot(t, color, size = 7)                   // kept
band(t, gradientName, percent) -> color   // see above
panel(t, {id, icon, title, accent = t.ansi4, right = "", body})
  // fieldset edge: corner, 4px line, icon + bold title in accent, line,
  // right text in dim, 4px line, corner; side and bottom borders; radius 8;
  // body: element or array; margin 12 px left/right, 10 px top.
rowLabel(t, iconName, word)               // 66 px label column: icon + word, dim
meter(t, percent, cells = 24, gradientName = "cpu")
  // 5x11 px cells, 2 px gap, lit cells band(...) of their own position, rest `hover`
coreCells(t, percents)                    // one 11x11 cell per core, band("cpu", p)
history(t, samples, color, {height = 70, max = 100})
  // full width: grid lines 25/50/75 % in hover, filled area (opacity .16) and
  // 1.3 px line, gaps at null, end dot; new code built from charts.js paths
sparkline(t, samples, color, {width = 120, height = 16, max = 100})
  // fixed size, same paths without grid
chip(t, name, health)                     // "ok" ansi2, "error" ansi1, "loading" dim dot
segmented(t, {id, options: [label], selected, onSelect})
table(t, columns, rows, selectedKey)      // kept; header dim, column {align: "right"}
num(t, text, color = t.foreground, width) // right-aligned mono cell
```

Charts draw with the global `window.paint_path` as herdwatch does; `ui.js`
must not import `window` from "herdr" (one-line comment). Icons copied from
herdwatch `icons/ui` into `deck/icons/`: gauge, bot, layers, cpu,
memory-stick, hard-drive, arrow-down-up, server, git-branch, history,
microchip.

### Frame and tab contract (`main.js`)

- Font: `mono()` at 12 px for the whole window.
- Header 40 px: `deck`, one `chip` per machine (`here` first), spacer,
  `segmented` 2m/5m/10m, the close button (PR #3).
- Tab strip: each tab's `icon` (a Lucide name string, e.g. "gauge"), label,
  count, blocked dot. `TABS = [overview, agents, swarm]`; Overview first.
- Machines: every machine except layout `"loading"` (chip `loading`).
  `"unavailable"` is not probed: `{ok: false, error: "unavailable"}`.
  A chip is `ok` when its probe and every tab's `load` said ok.
- `go(target)` also takes `{tab: id}`: switches to that tab.
- Range: `this.range` in samples, 24/60/120 (2/5/10 min at 5 s), default 60.

New tab interface (written into RECIPE.md "Adding a tab"):

```js
load({machines, state, board, probe}) -> Promise<{state, machines: {name: "ok"|"error"}}>
view(state, sel, cx, pick, {range, probe, t})   // t: theme()
// plus id, label, icon, count(state, probe), blocked(state, probe), rows(state, probe)
```

`swarm.js` gets the extra arguments and ignores them.

### Sampling (`probe.js`, owned by T1)

A **separate timer** in `main.js`, every 5 s while open, independent of the
tabs' `load` (a stuck `readTextFile` cannot stall the charts). Per machine,
in parallel:
`exec("sh", ["-c", PROBE, "probe", ...ids], {on, timeout: 3000})` where `on`
is null here or the machine name, and `ids` are the bare terminal ids (`t6q`,
without `machine/`) of that machine's agents (`agents()` addresses), at most
30. Arguments are passed as `"$@"`, quoted in the script; no `eval` (remote
output is untrusted too: parse only, never execute).

`PROBE` is a constant script that prints labelled sections:

```
@up        first field of /proc/uptime
@stat      the cpu and cpuN lines of /proc/stat
@mem       MemTotal MemAvailable SwapTotal SwapFree (kB) from /proc/meminfo
@disk      df -kP / last line (size used avail, KiB)
@net       /proc/net/dev lines except lo
@hz        getconf CLK_TCK
@proc      per process: pid ppid utime+stime(ticks) rss(pages) from
           /proc/[0-9]*/stat, fields after the last ")" (awk), and @pagesize
@term <id> one line: `hc get <id> --json` (hc from PATH or ~/.local/bin/hc)
@git <id>  for that terminal's foreground cwd: repo name and branch:
           git -C "$cwd" rev-parse --abbrev-ref HEAD --path-format=absolute --git-common-dir
           (repo = basename of the common dir without /.git, so worktrees
           show their repo)
```

`hc get --json` was checked live: it has `pid` (the terminal's shell),
`created_ms` and `foreground: {pid, cwd, argv, name}`. `hc ls --json` and
`terminals()` do not have pids, so the probe asks `hc get` per agent. The
script reads the cwd for `@git` from the same `hc get` output with `sed`.

`probe.js` exports pure functions (node tests in `probe.test.mjs`):

- `parse(text) -> raw` (all sections above as numbers/objects).
- `step(prev, raw) -> sample`: `seconds` = delta of `@up`; CPU % total and
  per core from `/proc/stat` deltas; net bytes/s; per process CPU % from tick
  deltas / `@hz` / seconds. With no `prev`, CPU, net and process CPU are
  `null`. Test: `step(null, a).cpu === null`, `step(a, b).cpu` is a number.
- `tree(procs, rootPid) -> {cpu, rssKiB}`: the process and all descendants.
- `record(store, machine, result)`: appends to module-scope ring buffers,
  oldest first, at most 120; a failed or skipped probe appends `null`
  (a gap); drops agent buffers whose address is gone.

`ctx.probe` (what T2 and T3 read), keyed `"here"` or the machine name:

```js
/** @typedef {{
 *   ok: boolean, error: string|null,         // error: stderr or message
 *   sample: null | {
 *     up: number,                            // seconds
 *     cpu: number|null, cores: (number|null)[],          // percent
 *     mem: {pct, usedKiB, totalKiB, swapPct},
 *     disk: {pct, freeKiB, totalKiB},
 *     net: {rxBps, txBps} | null,
 *   },
 *   history: {cpu: (number|null)[], mem: (number|null)[], rx: (number|null)[], tx: (number|null)[]},
 *   agents: {[address]: {                    // address as in agents(): "t6q" or "106/t6q"
 *     cpu: number|null, rssKiB: number|null, // tree of the terminal's shell pid
 *     created_ms: number|null, repo: string|null, branch: string|null,
 *     history: (number|null)[],              // cpu, at most 30
 *   }},
 * }} MachineProbe */
```

Views slice the last `range` samples of `history` themselves. A failed probe
keeps the last `sample`, sets `ok: false`, and appends `null`.

### Overview tab (`tabs/overview.js`)

One `panel` per machine (`here` first). Title: `server` icon, machine name;
right: `linux · up 4h`. A failing machine: the panel with its `error` in
`ansi1` and no rows. Rows (each with `rowLabel`):

- `cores`: `coreCells`.
- `cpu`: `meter`, then `34%` (bold) `8 cores` (dim); `history` of `cpu` in
  `ansi2`, range slice.
- `mem`: `meter(..., "mem")`, `47%  10.9 / 23.3 GiB · swap 6%`; `history` in
  `ansi6`.
- `disk`: `meter(..., "disk")`, `36%  291.9 GiB free`.
- `net`: two `sparkline`s (rx `ansi6`, tx `ansi4`, max = the larger peak in
  range) and `↓ 8 KB/s ↑ 6 KB/s`.
- `agents`: `3 working · 1 needs you · 2 idle` from `agents()` of that
  machine.

`rows()`: one per machine panel, target `{tab: "agents"}` (enter or click
switches to Agents). Count: machines up.

### Agents tab (`tabs/agents.js` + `agents-model.js`)

Rows come from `agents()` (`address`, `status`, `app`, `program`,
`space_name`, `tab_name`, `space`). Machine: `spaces()` entry with that
`space` -> `machine` (null = here). Joined by address with `terminals()` for
`report.msg`, and with `ctx.probe[machine].agents[address]` for the numbers.

| column | value |
| --- | --- |
| agent | `glyph(program)` + short app name (`claude`, `codex`, `agy`, else `app`) |
| state | dot + word: `working` (`working`), `needs you` (`blocked`), `done` (`done`), `idle` (`idle`) |
| where | repo (`ansi4`) + branch; without a repo: `space_name / tab_name` (`muted`) |
| doing | `report.msg`, truncated, `muted` |
| cpu ~ | `sparkline` of the agent's history |
| cpu | `14.8` |
| mem | `1.4G` / `612M` |
| up | from `created_ms`: `42m`, `3h`, `2d` |

A machine other than `here` adds its name as a dim prefix in `where`.
Sorted: needs you, working, done, idle; then here first, then by space and
tab. Panel title `bot agents`, right side `3 working · claude uses most` (the
app with the highest total CPU; omitted while CPU is null). Rows target
`{terminal: address}` (enter focuses or peeks it, as Swarm rows do).
`agents-model.js` holds the join, sort, short names and formatting
(`fmtMem`, `fmtAge`), tested in `agents-model.test.mjs`.

### Swarm tab

Same data and model. View changes only: `panel` instead of `box`, mono,
state dots as in Agents, the stage rail kept. With no open run: one dim line
`No open run. Start one with swarm new.` and the served panel below it.

### Search and PR state

- **PR state.** Each served run with a `pr` URL gets `pr_state`: `merged`,
  `pr open`, `closed`, `no pr` or `pr ?` (not known yet), shown with a dot
  (done, working, ansi1, dim). `swarm.js` asks `gh pr view <url> --json state`
  in the background (never awaited by the tick; at most 3 calls per tick, the
  newest 20 closed runs): MERGED and CLOSED are final, OPEN is asked again after
  60 s, a failed call keeps the old value and retries after 60 s.
  `model(runs, live, now, prState, query)` takes a url -> state map. Open runs
  stay on top; in served, runs with an open PR come first, then newest first.
- **Search.** `/` or a click on the field at the right of the tab strip starts
  it; typed text builds `query`, `enter` keeps the filter, `escape` clears it
  and leaves search (another closes Deck). Tabs get `query` in `view` and
  `rows`. Swarm matches case-insensitively over run title, repo, id, task
  id/title, worker name, provider and model (every word must match); a run that
  matches only through tasks shows just those tasks. With a query, served
  searches all closed runs and shows up to 20. Overview ignores the query;
  Agents matches agent name, app, repo, branch, space/tab and what it is doing.

## Alternatives Considered

- **Install herdwatch itself next to Deck.** Gives the look at once, but it
  needs SSH to `localhost` and a `hosts.conf`, duplicates Herdr's machine
  list, and leaves two consoles. The user wants one roof. Rejected.
- **herdwatch's fixed Tokyo Night palette.** Exactly its look, but it would
  ignore the user's Herdr theme. Mapping to `ansi` tokens keeps the look and
  the theme. Chosen.
- **Match agent processes by cwd and name (herdwatch's way).** Needs no
  `hc`, but guesses when two agents share a folder. `hc get` gives the exact
  pid. Chosen: `hc get`.
- **A probe per tab.** Two `exec`s per machine and two CPU baselines. One
  shared probe on its own timer. Chosen.

## Detailed Implementation Plan

T1 first; T2 and T3 in parallel after it, each owning only its files.

#### T1: look, frame, probe

Files: `deck/ui.js`, `deck/main.js`, `deck/probe.js`, `deck/probe.test.mjs`,
`deck/tabs/swarm.js`, stub `deck/tabs/overview.js` and `deck/tabs/agents.js`
(a panel "coming", with `id`, `label`, `icon`, `count`, `blocked`, `rows`,
`load` returning `{state: null, machines: {}}`), `deck/icons/`,
`deck/LICENSES.md`, `deck/RECIPE.md`, `deck/fixture/probe-here.txt` (one real
probe output from this machine, for T2/T3 and tests).

#### T2: Overview

Files: `deck/tabs/overview.js` only.

#### T3: Agents

Files: `deck/tabs/agents.js`, `deck/agents-model.js`,
`deck/agents-model.test.mjs`.

### Verification

- `node deck/swarm-model.test.mjs && node deck/probe.test.mjs && node deck/agents-model.test.mjs`
- Copy to `~/.config/herdr-app/mods/deck`, `herdr-app check`, open it, and
  `herdr-app shot` each tab with real data; compare with herdwatch's
  `assets/card-agents.png` and `card-resources.png`.

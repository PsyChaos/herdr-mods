# Deck: one console for the herd

**Status:** Approved (EGM review: design + readiness, findings resolved)
**Date:** 2026-11-18

## Overview

Deck is a new Herdr mod: one dense, keyboard-driven console window in the
style of a system monitor (btop, herdwatch), with one tab per subject. This
first version ships the console frame and its first tab, **Swarm**: every
swarm task, who works on it, what that agent is doing right now, where the
task is in the pipeline, and why a review sent it back. The other mods in this
repository (usage, team, ports, docker, machines, ci) become Deck tabs later,
one PR each, using the same frame and components.

## Terms

- **Swarm run, task, chef, worker, reviewer, resolver**: as in
  `herdr-swarm`. The chef is the agent that runs `swarm`; workers build tasks;
  reviewers and resolvers are helpers started for a task.
- **board.json**: the snapshot `swarm` writes atomically after every state
  change (`$SWARM_STATE/board.json`, default
  `~/.local/state/herdr-swarm/board.json`). The Pass (`herdr-swarm/mods/pass`)
  reads it today.
- **Report**: what an agent says it is doing, sent with OSC 7501. In a mod,
  each `terminals()` entry carries it as
  `report: {app, msg, state}` (verified on a live Claude Code terminal:
  `report.msg` = "Finding how new mods are picked up", `status` = "working").
  Claude Code's `msg` is the description of its latest tool call.

## The Problem

During a swarm the user wants one window that answers: who works on which
task, what each one is doing at this moment, and why something went back.
Today the Pass shows the stage of each task but no names, no live activity and
no findings; the answers are spread over each worker's terminal. Separately,
ten mods each open their own window with their own look, so watching the herd
means juggling windows.

## Goals

- One window, opened with one key, with a tab strip; the frame and its
  components (header, tabs, titled box, table, status dot, stage rail,
  provider glyph) are shared by every later tab.
- Swarm tab, per task: worker name and provider, model and effort, stage,
  state word, the live report message of whoever is at the task (worker or
  helper), and elapsed time.
- Per run: title, repo, base, machine, age, and the chef's live report.
- A sent-back task lists up to 3 findings of its latest review.
- Runs on every reachable Herdr machine appear, tagged with their machine.
- Keyboard: tab switching and row movement without the mouse; Enter goes to
  the selected row's terminal.
- Nothing new polls beyond one file read per machine every 4 s while the
  window is open; nothing runs while it is closed.

## Non-Goals

- Porting the other mods in this PR. Each becomes a tab in its own PR later;
  the existing mods stay installed and unchanged until then.
- A tab-row "pill" (always-visible summary strip). Future Improvement.
- Charts and history (CPU, memory). They come with the machines tab.
- Acting on workers from Deck (sending text, stopping). Going to the terminal
  is the only action.
- Removing The Pass. It stays in herdr-swarm; Deck does not depend on it.

## Open Questions

- None blocking.

## Critical User Journeys (CUJs)

### CUJ 1: Watching a run

The user presses Ctrl+Shift+I. Deck opens on the Swarm tab. The header shows
`deck`, one chip per machine (green dot reachable, grey unreachable). The tab
strip shows `swarm 3` (3 = tasks with someone at them). The run box is titled
`Shared agent memory` with `herdr-swarm · main · omarchy-hub · 14m` on the
right. Its first line: `chef t7p  Waiting for T2 review`. Rows:

```
id  task                      worker         model      stage  state     doing now                      time
T1  bin/mem core              ◆ thor         sol·high   ●●●●○  review    storm: Reading bin/mem          12m
T2  mem install               ◆ hawkeye      sol·med    ●●○○○  cooking   Running the test suite           4m
T3  templates and docs        ◆ hulk         sol·med    ●●●●●  plated                                    9m
```

### CUJ 2: A task comes back

T4's row turns red: state `sent back`. Under it, indented:
`high    tools/mem-bench.sh:79   The clean repo is a full local clone…` and
up to two more. When the worker starts fixing, its live report fills
"doing now"; the findings stay while the stage is `sent_back`.

### CUJ 3: Somebody needs you

A worker asks a question. Its state reads `needs you` in the blocked color,
the row sorts to the top of its run, and the tab label shows a blocked dot.
The user presses `j`/`k` (or arrows) to the row and Enter; Deck focuses that
terminal (or peeks it when it has no pane).

### CUJ 4: After the run

The run closes. It moves to a `served` box at the bottom: one line per run
with title, task count, duration and PR; Enter or click opens the PR.

## Technical Plan (Architecture)

### Two repositories

- **herdr-swarm** adds three fields to `board.json` (additive; version stays
  1). One small PR.
- **herdr-mods** adds `deck/`. It reads `board.json` and Herdr's live API. It
  works with an old board: missing fields mean no name and no findings.

### board.json additions (herdr-swarm)

- `tasks[].name`: the hc name the worker was started with. `swarm spawn`,
  `swarm review` and `swarm resolve` add `"name": <pick_name result>` to the
  event detail they record; `build_board` takes the latest `spawn` event's
  name. Older events: `null`.
- `tasks[].helpers[].name`: the same for each review/resolve helper.
- `tasks[].review.items`: built from the task's `review_json` findings
  (`json_dict(t["review_json"]).get("findings", [])`); the latest `reviewed`
  event only decides whether they are shown. Present only when that event has
  `ok: false` and no `spawn` event for the task follows it. Up to 3 findings,
  severity order high, medium, low, then anything else (emitted as
  `"unknown"`), then original order. Each `{"severity", "file", "line",
  "issue"}`: missing file or line -> `null`, missing issue -> `""`; `issue` is
  its first sentence (text up to the first `". "`, which may also cut at
  "e.g. " - accepted), cut so that it is at most 140 characters including the
  trailing `…`.

### Deck frame (herdr-mods/deck)

- `mod.json`: `place: none`, a kept window overlay, key `deck`, 980×620.
- **Header** (36px): `deck` in semibold, then machine chips: `here` for this
  computer first, then each `machines()` entry whose `layout` is not
  `unavailable`, by name. A chip's dot is green (`done` token) when that
  machine's last tick resolved for every tab that reads it (a `null` result,
  e.g. no board file, counts as resolved) and grey (`border` token) when a
  read rejected (machine unreachable).
- **Tab strip** (32px): one entry per tab: icon, label, `count(state)`; the
  active one in a rounded box; a dot in the `blocked` token when
  `blocked(state)`.
- **Body**: the active tab's `view`. Shared components in `ui.js`:
  `box(title, right, children)` (a bordered box with the title inset at the
  top-left and a summary at the top-right), `table(columns, rows, selectedKey)`
  (dim column headers, fixed widths, the selected row highlighted with the
  `hover` token), `dot(color)`, `rail(stage, color)` (five 6px pips
  FIRE/COOK/TASTE/REVIEW/PASS; reached pips filled in `color`; `sent_back`
  draws reached pips in the sent-back color; `dropped` draws all pips in
  `dim`), `glyph(program)` (provider icon, as the Pass's `glyph`). Colors come
  only from `cx.theme()` tokens.
- **Tab contract** (`tabs/*.js`): each tab exports
  `{id, label, icon, load(ctx), count(state), blocked(state), rows(state), view(state, sel, cx)}`.
  - `load(ctx)` -> `Promise<{state, changed, machines: {name: "ok"|"error"}}>`:
    the tab fetches its own data (`ctx` gives `machines` and the previous
    `state`); the frame calls every tab's `load` on its 4 s tick while the
    window is open (counts and blocked dots need all tabs), then calls
    `cx.notify()` on every tick, changed or not (live `terminals()` data such
    as report messages may change without a Herdr notification).
  - `rows(state)` returns the selectable rows in display order, each with a
    stable `key` (Swarm: `<machine>:<run>:<task>`) and a `target`
    (`{terminal, machine}` or `{url}`). Findings lines are not rows.
  - The frame keeps the selected **key** per tab, not a position. When the key
    is gone after a reload, the selection moves to the row now at the old
    position (clamped), or none when the tab is empty.
  - Adding a tab later = one file and one line in the tab list.
- **Keyboard** (a window overlay does not take the keyboard by itself, and Esc
  goes to the mod): in `init`,
  `this.h = cx.focus_handle(); this.h.focus(); cx.timer.after(600, () => this.h.focus())`
  (the pattern team/ and docker/ use). The root element gets
  `.track_focus(this.h)`, `.on_key_down((e, cx) => ...)` matching
  `e.keystroke`, and `.on_mouse_down("left", () => this.h.focus())` without
  stopping propagation (the window stays draggable). Keys: `j`/`down`,
  `k`/`up` move the selection; `enter` acts on it; `1`..`9` pick a tab;
  `tab`/`shift-tab` cycle tabs (if GPUI's focus order takes Tab first, `[` and
  `]` do the same and Tab is dropped - the worker checks); `escape` runs
  `closeOverlay(props().overlay)`. Each handled key calls
  `cx.stop_propagation()`. Global open key `ctrl-shift-i` in `keys.json`
  (free in the current keys; the worker checks `keys()` before shipping).
- **Acting**: a target with `terminal` runs `pane.focus {terminal}` when
  `panes().some((p) => p.terminal === address)`, else `terminal.peek
  {terminal}` (address machine-qualified for remote ones, as the Pass's
  `focus`). A target with `url` runs `exec("xdg-open", [url])`.
- **Remote paths**: a tab that resolves a path on a machine with `exec` keeps
  it only when `exec` resolved; when it rejects (machine still loading or
  unreachable), it tries again on the next tick and does not store a default.

### Swarm tab (`tabs/swarm.js` + `swarm-model.js`)

- **Reuse**: `swarm-model.js` copies from herdr-swarm `mods/pass/plate.js`
  and `main.js` (same author, MIT): `addressOn`, `mergeBoards`,
  `shortModel`, `providerKey`, the effort short words, and the live-status rule.
  Deck does not import from the Pass.
- **load**: `board.json` read with `readTextFile(path, {on})` on this computer
  and each machine from `ctx.machines`. Path:
  `exec("sh", ["-c", 'printf %s "${SWARM_STATE:-$HOME/.local/state/herdr-swarm}"'], {on})`
  then `/board.json` (kept per machine only after a resolved `exec`). A
  resolved `null` = no runs there; a rejection marks that machine `error`.
  Parse and merge only when a file's text changed (`changed: true`); runs are
  tagged with their machine.
- **Live status** (as the Pass's render): for `terminals()` entries with
  `state === "live"`, status = the `agents()` status for that address, else
  the entry's `status`; plus its `name` and `report.msg` when `report` is an
  object with a string `msg`. `main.js`/`tabs/swarm.js` builds
  `live: Map address -> {status, name, msg}` once per render; remote addresses
  are `machine/tN`.
- **`swarm-model.js`** (pure, no Herdr imports, unit-tested with node):
  `model(runs, live, now)` returns `{open: [{run, chef, rows}], served}` with
  rows `{key, id, title, worker: {name, provider, model, effort}, stage,
  state, color, doing: {who, msg} | null, elapsed, findings, target}`.
  - **State word** (first match wins) and color token:

    | Condition | State | Color |
    | --- | --- | --- |
    | stage `dropped` | `dropped` | `dim` |
    | worker or a working/blocked helper is `blocked` | `needs you` | `blocked` |
    | stage `sent_back` | `sent back` | `ansi1`, else `blocked` (as the Pass) |
    | a review helper is `working` | `review` | `working` |
    | a resolve helper is `working` | `fixing` | `working` |
    | worker `working` | `cooking` | `working` |
    | stage `pass` | `plated` | `done` |
    | stage `taste` or `review` | `checked` | `muted` |
    | anything else | `waiting` | `dim` |

  - **doing**: the first of (working/blocked helpers in board order, then the
    worker) whose live `msg` is a non-empty string; `who` = that helper's
    name (board `name`, else live `name`, else its role), or `null` for the
    worker. A missing or non-object `report` gives no `msg`.
  - **target**: as the Pass's `plate.js`: blocked worker, blocked helper,
    working worker, working helper, else the worker's terminal if live, else
    none.
  - **Worker name**: the board's `name`, else the live terminal's `name`,
    else `null` (the view then shows the provider name).
  - **elapsed**: `started` -> `finished ?? now`, shown as `<n>m`/`<n>h`.
  - **findings**: for state `sent back` only: `review.items` when present;
    otherwise up to 3 of `check.problems` as `{severity: "check", issue}`.
  - **Order** inside a run: needs you, sent back, review, fixing, cooking,
    checked, waiting, plated, dropped; then task id.
- **Runs**: open runs newest first, one box each, titled with the run title,
  right side `repo · base · machine · age`. First line: the chef's label (its
  live `name`, else its address) and its live `report.msg`, omitted when
  empty.
- **Served**: one box with the 5 newest closed runs across all machines after
  merging: title, task count, duration (latest task `finished` minus run
  `created`; blank when unknown) and the PR; its row target is `{url: pr}`.
- **Empty**: "No swarm runs." and a dim hint: "Start one with `swarm new`."
- **count**: rows in state cooking, review, fixing or needs you;
  **blocked**: any row `needs you`.

## Alternatives Considered

### Alternative A: Extend The Pass

Adds names, activity and findings to the existing kitchen-ticket panel. It
answers the swarm question but leaves ten separate windows with ten looks,
and the Pass's ticket layout does not fit a table of who/what/doing. Rejected
in favour of a console that every mod can join.

### Alternative B: Install herdwatch and add a swarm view to it

Herdwatch (MIT) is an SSH-polling monitor of hosts; its data comes from shell
scripts over SSH, not Herdr's API, and it knows nothing of swarm. Bending it
to Herdr's live data and board.json would mean rewriting most of it and
tracking an outside project. Its look (header chips, tab strip with counts,
titled boxes, dense tables) is the reference for Deck; no code is copied.

### Alternative C: Read workers' screens for activity

`hc read --lines 0` per worker per refresh: a process each time and fragile
TUI parsing, while `report.msg` is already the agent's own one-line summary.
Rejected.

## Non-Functional Requirements

- Cost: closed window = nothing runs. Open window = one `readTextFile` per
  machine every 4 s plus a re-render; `exec` only to resolve a path once per
  machine.
- Remote machines: an unreachable machine shows a grey chip and no runs; it
  never blocks the others.
- Compatibility: works with boards without the new fields; old panels ignore
  them.
- Theme: only `cx.theme()` tokens, so every Herdr theme works.

### Future Improvements

- Tabs: usage, agents/team, ports, docker, machines, ci (one PR each).
- A pill in the tab row with the swarm summary.
- A findings popover with every finding and the worker's summary.

## Detailed Implementation Plan

### PR A (herdr-swarm): board fields

#### 1. `bin/swarm` (Modify)

`cmd_spawn`, `cmd_review`, `cmd_resolve` add `"name": name` to their event
detail. `build_board` adds `task["name"]`, `helper["name"]` and
`review["items"]` as specified above.

#### 2. `tests/test_board.py` (Modify)

Update the exact-shape assertions: the helper dict (around line 180) gains
`"name": None`, the task key set (around line 268) gains `"name"`; the review
dict assertion (around line 273) stays (no `ok: false` reviewed event there,
so no `items`). New cases: names from spawn and review events; `null` without
one; items taken from `review_json` findings and shown only after an
`ok: false` reviewed event with no later spawn;
severity order and cap of 3; unknown severity last; cut at 140 with `…`;
missing file/line/issue.

#### 3. `README.md` (Modify)

The board contract paragraph lists `name`, `helpers[].name` and
`review.items`.

### PR B (herdr-mods): Deck

#### 4. `deck/mod.json`, `deck/keys.json` (Create)

As in "Deck frame".

#### 5. `deck/main.js` (Create)

The frame: header, machine chips, tab strip, selection and keys, the 4 s tick
while open, routing Enter/click to `pane.focus {terminal}` (when the terminal
has a pane), `terminal.peek` (otherwise) or `xdg-open <url>`.

#### 6. `deck/ui.js` (Create)

The shared components listed in "Deck frame".

#### 7. `deck/tabs/swarm.js`, `deck/swarm-model.js` (Create)

The Swarm tab and its pure model.

#### 8. `deck/swarm-model.test.mjs` (Create)

`node deck/swarm-model.test.mjs`. Cases: each state word; `doing` from a
working helper over the worker; blocked helper; empty or missing `msg`; a
`report` that is a string or missing -> `null`; name fallback to provider;
row order; remote addresses (`machine/tN`); findings only for `sent back`,
from `review.items`, else from `check.problems`; stable row keys; target
precedence; served duration and order across machines; a board without the
new fields.

#### 9. `deck/fixture/board.json` (Create)

Two open runs covering every state (including a sent-back task with
`review.items` and named helpers) and one served run with a PR. The window
opens it with the `board` prop, as the Pass's fixture does.

#### 10. `deck/RECIPE.md` (Create), `README.md` (Modify)

RECIPE: what you see, how it behaves, data, the tab contract for later tabs,
install. README: a Deck row in the mod table and its install lines.

### Verification Plan

- herdr-swarm: `python3 -m unittest discover -s tests -q`.
- herdr-mods: `node deck/swarm-model.test.mjs`; `herdr-app check deck` after
  copying it to `~/.config/herdr-app/mods/deck`.
- Visual: open the fixture view and take `herdr-app shot`; check header,
  tabs, each state's row, findings and served box at 980×620 and at a narrow
  width (columns truncate, nothing overlaps).
- Keyboard: after opening, `j`/`k` move without clicking; after Enter focuses
  a terminal, clicking Deck gives it the keyboard back; Esc closes it.
- Live: during the next real swarm run, the "doing now" column changes within
  4 s of a worker's new tool call, and Enter on a row focuses its terminal.

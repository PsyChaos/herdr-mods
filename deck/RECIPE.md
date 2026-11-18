# Deck

One console window for the herd: a header, a tab strip and the active tab's
view. Tabs: **Overview**, **Agents**, **Swarm**; the other mods become tabs later.

## What you see

A window, 980×620, kept across restarts, opened with Ctrl+Shift+I, in the
Herdr mono font with the look of herdwatch (colors from the theme only):

- A 40px header: `deck`, a chip per machine (`here` first, then every machine
  except layout "loading"), a 2m/5m/10m range control, the close button. A chip
  dot is green when the machine's probe and every tab's last read said ok, red
  when one failed, dim while loading.
- A 32px tab strip: Lucide icon, label, count; the active tab sits in a rounded
  `hover` box; a `blocked` dot shows when something needs you.
- Tabs: Overview, Agents (stubs "coming" until their files land) and Swarm.
- Swarm: one panel per open run, newest first (title cut into the top border;
  right side `repo · base · machine · age`). First line: `chef <name>` and its
  report. Then a table: id, task, worker, model·effort, stage rail, state (dot
  and word), "doing now", time. A sent-back row has up to three findings under
  it. A `served` panel lists the 5 newest closed runs with their PR state (`merged`, `pr open`, `closed`, `no pr`, `pr ?`; from `gh`, open PRs first); its rows open the PR.
  With no open run: "No open run. Start one with swarm new." above `served`.
- State colors: `needs you` blocked, `sent back` ansi1 (else blocked),
  `review`/`fixing`/`cooking` working, `plated` done, `checked` muted,
  `waiting`/`dropped` dim.

## Keys

`j`/`down`, `k`/`up` move the selection; `enter` goes to the row's terminal
(`pane.focus` when it has a pane, else `terminal.peek`) or opens the PR;
`1`..`9` and `tab`/`shift-tab` pick a tab; `escape` closes. Clicking the
window gives it the keyboard back. The selection follows the row's key, not
its position; when the row is gone it moves to the row now at that place.

Search: `/` (or a click on the field at the right of the tab strip) starts it;
typed characters build the query, backspace edits, `enter` keeps the filter,
`escape` clears it and leaves search (another `escape` closes Deck). While
typing, j/k/digits/tab are text.

## Data

Every 4 s while open each tab loads and the view redraws (nothing runs while the
window is closed). Separately, every 5 s `probe.js` runs one `sh` script per
machine (`exec ... {on}`, 3 s timeout) and keeps ring buffers of at most 120
samples in module scope, so charts survive close and reopen. Pure functions
(`parse`, `step`, `tree`, `record`) are tested by `node deck/probe.test.mjs`
against `fixture/probe-here.txt`. Range (24/60/120 samples) is `this.range`.

`ctx.probe` / the view's `probe` is keyed `"here"` or the machine name:
`{ok, error, sample: {up, cpu, cores, mem, disk, net} | null, history: {cpu, mem,
rx, tx}, agents: {[address]: {cpu, rssKiB, created_ms, repo, branch, history}}}`.
CPU and net are `null` on the first sample. A failed probe keeps the last
`sample`, sets `ok: false` and appends `null` (a gap). Slice `history` to the
range yourself.

Swarm reads `board.json` with `readTextFile` here and on each machine; the path
comes from `exec sh -c 'printf %s "${SWARM_STATE:-...}"'`, kept per machine
only once that resolved. Live names and messages come from `terminals()`
(`report.msg`). The pure part is `swarm-model.js` (`node
deck/swarm-model.test.mjs`). Hidden prop `board`: a local file to read instead
(`deck/fixture/board.json`).

## Adding a tab

Create `tabs/<id>.js` exporting `{id, label, icon, load(ctx), count(state,
probe), blocked(state, probe), rows(state, probe), view(state, sel, cx, pick,
{range, probe, t})}` and add it to `TABS` in `main.js`. `icon` is a Lucide name
(a file in `icons/`); `t` is `theme()`; `query` is the text of the search field (`""` when none): filter your rows and view by it, or ignore it. `state` is `null` until the first load.

- `load({machines, state, board, probe})` -> `Promise<{state, machines: {name:
  "ok" | "error"}}>` (`machines` is `[null, ...names]`; `here` stands for `null`).
- `rows(state, probe, query)` -> `[{key, target}]` in display order; `target` is
  `{url}`, `{tab: id}` (switch to that tab), an address string, or `{terminal,
  machine}`.
- `view` draws with `ui.js` only (each export takes the theme first): `mono`,
  `icon`, `dot`, `band`, `panel`, `rowLabel`, `meter`, `coreCells`, `history`,
  `sparkline`, `chip`, `segmented` (`selected` is an index), `table`, `num`,
  `rail`, `glyph`. Call `pick(key, cx)` from a click.

## Install

```sh
cp -r herdr-mods/deck ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/deck
```

Add `"ctrl-shift-i": "mod.open:deck"` to `keys.json`. Needs the Swarm board
fields `name` and `review.items` for names and findings; without them rows show
the provider and no findings.

# Deck

One console window for the herd: a header, a tab strip and the active tab's
view. Tabs (keys `1`..`8`): **Overview**, **Agents**, **Swarm**, **Team**, **Usage**, **PRs**, **Ports**, **Docker**. Tabs not yet written show "Coming.".

## What you see

A window, 980×620, kept across restarts, opened with Ctrl+Shift+I, in the
Herdr mono font with the look of herdwatch (colors from the theme only):

- A 40px header: `deck`, a chip per machine (`here` first, then every machine
  except layout "loading"), a 2m/5m/10m range control, the close button. A chip
  dot is green when the machine's probe and every tab's last read said ok, red
  when one failed, dim while loading.
- A 32px tab strip: Lucide icon, label, count; the active tab sits in a rounded
  `hover` box; a `blocked` dot shows when something needs you.
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
`1`..`8` and `tab`/`shift-tab` pick a tab; `escape` closes. Clicking the
window gives it the keyboard back. The selection follows the row's key, not
its position; when the row is gone it moves to the row now at that place.

Search: `/` (or a click on the field at the right of the tab strip) starts it;
typed characters build the query, backspace edits, `enter` keeps the filter,
`escape` clears it and leaves search (another `escape` closes Deck). While
typing, j/k/digits/tab are text.

## Data

Every 4 s while open each tab loads on its own (a slow tab never delays another) and the view redraws (nothing runs while the
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

Create `tabs/<id>.js` and add it to `TABS` in `main.js`:

```js
export default {
  id, label, icon,                       // icon: a file name in icons/ without .svg (Lucide)
  load({machines, state, board, probe}), // -> Promise<{state, machines: {name: "ok"|"error"}}>
  count(state, probe), blocked(state, probe), rows(state, probe, query),
  view(state, sel, cx, pick, {range, probe, t, query}),
  ui,                                    // optional module-scope object, see below
  watch(cx),                             // optional, see "The watcher branch"
  submit(query, cx),                     // optional: Enter leaves the search field (e.g. ports opens the first match)
}
```

`t` is `theme()`; `query` is the search text (`""` when none): filter rows and view by it, or ignore it. `state` is `null` until the first load. `machines` is `[null, ...names]` (`null` = this computer); in the `machines` result of `load`, this computer is the key `"here"`.

- `rows(state, probe, query)` -> `[{key, target}]` in display order; `target` is `{url}` (opened with `openUrl`), `{tab: id}`, an address string, or `{terminal, machine}`.
- `view` draws with `ui.js` only (each export takes the theme first; colors only from its tokens): `mono`, `icon`, `dot`, `band`, `panel`, `rowLabel`, `meter`, `coreCells`, `history`, `sparkline`, `chip`, `segmented`, `table`, `num`, `rail`, `glyph`, and
  - `rowButton(t, {id, icon, tooltip, color, hover, disabled, onPress})` 18x18 icon button at a row's end;
  - `textButton(t, {id, label, primary, destructive, disabled, onPress})`;
  - `chips(t, {id, options: [{label, count}], selected, onSelect(index, cx)})`;
  - `confirm(t, dialog)` the dialog body Deck draws; `logView(t, lines, {height})`; `note(t, {text, level})`; `openUrl(url)` a detached opener.
  Call `pick(key, cx)` from a row click.
- **Cadence.** Deck calls `load` every 4 s. A tab with a slower cadence keeps its interval as a constant in its file and returns its cached state until then; a slow fetch runs in the background (module state) while `load` returns the cache at once.
- **Machine chips.** Report `"error"` for a machine only when it cannot be reached (exec rejects). Tool problems (docker missing, gh not logged in) show inside the tab, never on the chip.
- **UI state lives in module scope**, never in what `load` returns (a load in flight would overwrite it). A tab may export `ui`:
  - `ui.dialog`: `null` or `{title, lines, action, destructive, onConfirm(cx), onCancel(cx)}`. Deck draws `confirm` over the body, sends Enter to `onConfirm` and Escape to `onCancel` (each sets `ui.dialog = null` itself) and swallows other keys.
  - `ui.note`: `null` or `{text, level: "info"|"ok"|"warn"|"error", at}`; one line at the bottom for 8 s (`error` stays until the next note).
  - `ui.query`: set by another tab, Deck copies it into the search field once and clears it.
- **Opening on a tab.** On `init` Deck opens `shared("deck.tab")` (`{id, at}`) when `at` is under 10 s old, else the last tab used. Ask for a tab with `setShared("deck.tab", {id, at: Date.now()})`.
- **The watcher branch.** With prop `watch: "<id>"` the window is a hidden watcher: `init` calls only that tab's `watch(cx)` and `render` returns an empty div; no tick, no probe.

Tabs, each described in its own file: [overview](tabs/overview.md), [agents](tabs/agents.md), [swarm](tabs/swarm.md), [team](tabs/team.md), [usage](tabs/usage.md), [prs](tabs/prs.md), [ports](tabs/ports.md), [docker](tabs/docker.md) (written with each tab).

## Install

```sh
cp -r herdr-mods/deck ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/deck
```

Add `"ctrl-shift-i": "mod.open:deck"` to `keys.json`. Needs the Swarm board
fields `name` and `review.items` for names and findings; without them rows show
the provider and no findings.

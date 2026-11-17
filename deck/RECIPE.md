# Deck

One console window for the herd: a header, a tab strip and the active tab's
view. This version has one tab, **Swarm**; the other mods become tabs later.

## What you see

A window, 980×620, kept across restarts, opened with Ctrl+Shift+I:

- A 36px header: `deck`, then a chip per machine: `here`, then each machine
  whose layout isn't "unavailable". The dot is green (`done`) when every tab's
  last read from it resolved (a missing file counts) and grey (`border`) when
  a read failed.
- A 32px tab strip: icon, label and a count; the active tab sits in a rounded
  `hover` box; a `blocked` dot shows when something needs you.
- Swarm: one box per open run, newest first. Title = run title; right side =
  `repo · base · machine · age`. First line: `chef <name>` and its live
  report. Then a table: id, task, worker (glyph and name, else the provider),
  model·effort, stage rail, state word, "doing now" (`helper: message` when a
  reviewer or resolver is at the task), time. A sent-back row has up to three
  findings under it: severity, `file:line`, the first sentence of the issue.
  A `served` box lists the 5 newest closed runs (title, tasks, duration, PR);
  its rows open the PR. With no runs: "No swarm runs."
- State colors: `needs you` blocked, `sent back` ansi1 (else blocked),
  `review`/`fixing`/`cooking` working, `plated` done, `checked` muted,
  `waiting`/`dropped` dim. Theme tokens only.

## Keys

`j`/`down`, `k`/`up` move the selection; `enter` goes to the row's terminal
(`pane.focus` when it has a pane, else `terminal.peek`) or opens the PR;
`1`..`9` and `tab`/`shift-tab` pick a tab; `escape` closes. Clicking the
window gives it the keyboard back. The selection follows the row's key, not
its position; when the row is gone it moves to the row now at that place.

## Data

Every 4 s while open each tab loads (the window does nothing when closed) and
the view redraws. Swarm reads `board.json` with `readTextFile` here and on each
machine; the path comes from `exec sh -c 'printf %s "${SWARM_STATE:-...}"'`,
kept per machine only once that resolved. Live names and messages come from
`terminals()` (`report.msg`). The pure part is `swarm-model.js`
(`node deck/swarm-model.test.mjs`). Hidden prop `board`: a local file to read
instead (`deck/fixture/board.json`).

## Adding a tab

Create `tabs/<id>.js` exporting `{id, label, icon, load(ctx), count(state),
blocked(state), rows(state), view(state, sel, cx, pick)}` and add it to `TABS`
in `main.js`.

- `load({machines, state, board})` -> `{state, changed, machines: {name: "ok" |
  "error"}}` (`machines` is `[null, ...names]`; `here` stands for `null`).
- `rows(state)` -> `[{key, target}]` in display order; `target` is `{url}`, an
  address string, or `{terminal, machine}`.
- `view` draws with `ui.js`: `box`, `table`, `rail`, `dot`, `glyph` (each takes
  the theme first). Call `pick(key)` from a click.

## Install

```sh
cp -r herdr-mods/deck ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/deck
```

Add `"ctrl-shift-i": "mod.open:deck"` to `keys.json`. Needs the Swarm board
fields `name` and `review.items` for names and findings; without them rows show
the provider and no findings.

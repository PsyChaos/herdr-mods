# Browser

Opens a web page in a pane, next to your terminals and agents, with
[terminal-browser](https://github.com/zenbu-labs/terminal-browser): a real
Chromium drawn inside a terminal. For a Herdr machine on another computer, the
page loads through that machine, so its own `localhost` (a dev server) opens
without port forwarding.

![Open in browser](preview.png)

## What you see

A dialog, 460px wide, on `popover`:

- "Open in browser" in 15px semibold, "Esc" in 11px `dim` on the right.
- "Address" label (11.5px `dim`) and a 36px input with an `accent` border,
  placeholder "localhost:3000, a port, or any address". It holds the last
  address you opened, selected.
- "Load through": a chip per machine, "This computer" first, then each
  machine in `machines()`. The chosen one has an `accent` border on `selected`.
- One 11.5px `dim` line saying where the page runs and loads from.
- Errors in `blocked`: terminal-browser missing (with the install command),
  or why the browser didn't start.
- "Cancel" and "Open" (primary, "Opening…" while it starts).

## How it behaves

- The machine starts as the focused space's machine (`spaces()[i].machine`).
- Enter or "Open" runs, here:
  `hc run --bg --json -- env DO_NOT_TRACK=1 TERMINAL_BROWSER_NO_TELEMETRY=1 terminal-browser open --no-merge [--ssh <target>] <address>`.
  `<target>` is the machine's `target` from `hc machine ls --json`.
- The browser always runs on this computer, where Herdr draws it. With
  `--ssh`, terminal-browser sends its requests through that machine over ssh.
  Running it on the other machine instead would send every frame over the
  network.
- It waits until `terminals()` lists the new terminal, focuses the pane that
  was focused when the dialog opened, then `terminal.keep {place: "right"}`.
  Ctrl+Q in the browser ends it and closes its pane.
- The address is kept in shared state `browser.last-url`.

## Built from

- `main.js`: the dialog; `mod.json`: `place: none`, a dialog overlay 460px wide.
- Herdr: `focused()`, `spaces()`, `machines()`, `terminals()`, `panes()`,
  `hc([...])`, `exec("sh", ["-c", "command -v terminal-browser"])`,
  `run("pane.focus" | "terminal.keep")`, `shared`/`setShared`,
  `props().overlay`/`closeOverlay`.
- gpui-base `InputState` + `Input`.

## Watch out

- `terminal.keep` right after `hc run` fails with "no running terminal": Herdr
  sees the new terminal a moment later. Wait for it in `terminals()` first.
- `--ssh` needs ssh to the machine to work without a password prompt
  (keys or an agent), since nobody can type into it.
- terminal-browser's first start adds a skill for agents under
  `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills` (links to its
  own folder). Delete them if you don't want agents to use the browser.

## Done when

- `herdr-app check` passes.
- Ctrl+Shift+U, `example.com`, Enter: the page opens in a pane to the right.
- With another machine chosen and a server on its `localhost:<port>` that
  this computer doesn't have, `<port>` opens that machine's page.

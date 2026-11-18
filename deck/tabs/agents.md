# Agents tab

Every agent terminal on every machine, and the tasks agents handed out.

## What it shows

- **agents** panel: a row per agent (provider glyph, state, where it works, what it reports, CPU sparkline, CPU, memory, uptime). Sorted needs you, working, done, idle.
- **Tasks** sit in the same table, indented with `└` under the terminal that started them (`hc run` records the parent). A task is any terminal with a `parent` or a `task` label, shell helpers included. Its title replaces the "where" column: the `task` label, else the first sentence of the prompt (80 characters), else the terminal name or command. Inside a parent: urgent first, then newest. A task whose parent is not in the table (or a parent cycle) shows at top level.
- **finished** panel: the newest 10 ended tasks: title, provider, how it ended (`done` exit 0 or killed after idle, `failed` non-zero exit, `stopped` signal or unknown), exit code or signal, duration. Hidden when there are none.

## Data

- `agents()`, `spaces()`, `terminals()` live on every redraw; CPU and memory from Deck's probe.
- Finished tasks leave `terminals()`. `load` (every 4 s) remembers each live task; when one is gone it runs `hc get <address>` once and stores the result in `shared("task-board.finished")` (same key as the old task board, newest 50, so its history carries over).
- Pure logic and tests: `deck/agents-model.js`, `node deck/agents-model.test.mjs`.

## Actions

- Click a row or Enter: `pane.focus` when it has a pane, else `terminal.peek` (Deck's `go`).
- **Clear** (button under finished, confirm dialog): drops the history entries and runs `hc rm` on each ended task.
- Search (`/`): every word must appear in address, provider, repo, branch, place, report, machine or task title; finished tasks match title, provider, ending, exit and address.

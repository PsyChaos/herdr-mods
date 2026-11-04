# Ports

Which program or container listens on which TCP port, on this computer and on
every connected Herdr machine. A row opens its page in the [browser](../browser/)
mod, through that machine, goes to the Herdr terminal that started it, or
stops what holds the port after you confirm it.

## What you see

A window, 540×560, that you can drag anywhere:

- A 32px header: "Ports" in semibold, then in 10px `dim` "what you started ·
  N more hidden" ("everything that listens" with Show all, "N found, hidden
  ones too" while searching), then "Show all"/"Fewer", "↻" and "✕".
- A search input, placeholder "Search: 3000, node, redloop, ~/Projects…". It
  has the keyboard as soon as the window opens.
- A section per machine, "This computer" first: its name in `muted`
  semibold and "· N ports", "· reading…" or the error in `blocked`.
- A row per port:
  - `:<port>` in semibold, 52px wide;
  - the container name, or the program (`node`, `python3`), or "system" in
    `muted` when the port belongs to another user (root);
  - under it in 10px `dim`: the compose project folder, or the program's
    folder (its command when that is home), and "started in <tab / pane>" when
    a live Herdr terminal started it;
  - "network" in `blocked` when it listens on more than 127.x / ::1, so other
    computers can reach it;
  - "Open" unless the port never serves a page (ssh, mail, DNS, CUPS,
    databases, Redis, memcached; containers named like a database);
  - "Terminal" when its Herdr terminal is known and live;
  - "Stop" when the process is yours (it has a pid) or it is a container.
- Under a row being stopped: a confirmation box with a `blocked` border,
  "Stop <program> (pid N) on <machine>, listening on :<port>?", why to think
  twice (the whole program ends, not only the port; the Herdr terminal it runs
  in; that other computers use it; for a container, that its other ports stop
  and a restart policy may bring it back), "Cancel" and a `blocked` "Stop".
  Then "stopping…", or why it failed, or "Still listening" with "Force stop
  (kill -9)".
- A footer line explaining "network" and "Open".

## How it behaves

- Every 10 seconds, and on "↻", each machine runs one Python script (`PROBE`):
  `python3 -I -c` here, `hc exec --on <machine> -- python3 -I -c` elsewhere.
  It reads `ss -ltnpH`, then for each port's first process `/proc/<pid>/cmdline`
  (program, command), `/proc/<pid>/cwd` (folder, home as `~`) and
  `/proc/<pid>/environ` (`HC_TERMINAL_ID`, which every process started in a
  Herdr terminal inherits). `docker ps` adds the container name and its
  `com.docker.compose.project.working_dir`. It prints a JSON list.
- Shown by default: containers, and programs whose folder is under `~/`,
  below port 32768. "Show all" adds ports above 32768 (picked by editors,
  agents and debuggers for themselves) and system ports.
- The search looks at every port, hidden ones too: each word must appear in
  `:<port>`, the container, program, folder, command, terminal or machine.
  Machines with no match drop out. Enter opens the first matching port that
  serves a page. Esc clears the search, and closes the window when it is empty.
- "Open" sets shared state `browser.request` to `{url: "localhost:<port>",
  machine, at}` and runs `mod.open browser`. The browser mod opens a request
  younger than 5 seconds at once, loading it through that machine.
- "Stop" on a container runs `docker stop <name>`; on a process, `kill -s TERM
  <pid>`, but only if `ss -ltnpH "sport = :<port>"` still shows that pid (a pid
  can be reused in the seconds since the list was read). Both run on the
  port's machine. 2.5 seconds later the list is read again: the port is gone,
  or the same pid still listens and "Force stop" sends KILL. Esc closes the
  confirmation first.
- "Terminal" matches `HC_TERMINAL_ID` to `terminals()` (`<machine>/<id>` for
  another machine) and runs `pane.focus` if the terminal has a pane, otherwise
  `terminal.peek`.

## Built from

- `main.js`: the window; `mod.json`: `place: none`, a window overlay.
- Herdr: `machines()`, `terminals()`, `panes()`, `exec`, `hc([...])`,
  `run("pane.focus" | "terminal.peek" | "mod.open")`, `setShared`,
  `props().overlay`/`closeOverlay`.
- gpui-base `InputState` + `Input`.

## Watch out

- `ss` shows the process only for your own user's ports; root's ports have
  no program and count as "system".
- A port that Docker publishes is held by `docker-proxy` (root), so the
  container name comes from `docker ps`, not from `ss`.
- A program started outside Herdr (an editor's terminal, a systemd unit) has
  no `HC_TERMINAL_ID`, so it has no "Terminal".

## Done when

- `herdr-app check` passes.
- "Stop" on `python3 -m http.server 9999` asks first, then frees the port.
- Ctrl+Shift+Y lists a dev server you started in a Herdr terminal, with
  "started in" and its folder; "Terminal" focuses that terminal.
- "Open" on a port of another machine opens its page there.
- Typing `5432` finds a database even though it is hidden by default.

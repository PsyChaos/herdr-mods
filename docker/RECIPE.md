# Docker

The containers on this computer and on every connected Herdr machine in one
window, grouped by compose project. Search them, show only the running or the
stopped ones, start, stop and restart them, and open their logs or a shell in
them as Herdr terminals on their own machine.

## The window

A window, 620×640, that you can drag anywhere (Ctrl+Shift+S):

- A 32px header: "Docker", then "All N", "Running N", "Stopped N" (the chosen
  one on `selected`, its counts after the search), "↻" and "✕". "Running"
  covers paused and restarting containers too. The choice stays in
  `shared("docker.filter")`.
- A search input with the keyboard as soon as the window opens. Every word must
  appear (case ignored) in the container's machine ("This computer" or its
  name), compose project, project folder, name, image, service, state, status
  or published ports (":5432"). Esc clears it, then closes the window.
- The machines mod's "Open in Docker" puts `{search: <machine label>, at}` in
  `shared("docker.request")`: one younger than 5 s fills the search, when the
  window opens and, checked every 500 ms, while it is open; it is cleared once
  read.
- Per machine, a band on `raised`: its name in semibold, then in 10px "N running
  · N stopped", "reading…", "Docker isn't installed here." or the error in
  `blocked`. While searching or filtering, a machine with nothing left is left
  out.
- Per compose project (those with a running container first, then by name;
  "Other containers" for ones without a project last): its name in semibold,
  its folder and "N/M running" in `dim`.
- Per container: a 7px dot (`done` running, `working` restarting, paused or
  "health: starting", `blocked` unhealthy or dead, `dim` stopped), its name
  (`muted` when stopped), and under it in 10px `dim`: image · status ("Up 5
  hours (healthy)", "Exited (0) 13 days ago") · ports · CPU and memory while
  running. Buttons: "Logs"; "Shell" while running; "Restart" and "Stop" when
  up, "Resume" and "Stop" when paused, "Start" when stopped.
- "Stop" and "Restart" open a box with a `blocked` border: "Stop <name> on
  <machine>?", what it means (whatever uses it loses it; a restart policy may
  start it again), "Cancel" and the action. "Start" and "Resume" don't ask.
  While an action runs, "stopping…" (etc.) under the row, and the row's
  Start/Stop/Restart/Resume and Shell buttons are off (`dim`, half opacity,
  clicks ignored) until the machine has been read again after it, so a second
  request can't be sent and the old state's button never comes back meanwhile.
  A failure stays under the row in `blocked`. Logs and Shell are off the same
  way while their terminal starts.
- A footer: what opening a terminal is doing or why it failed, else "Logs and
  Shell open as terminals on the container's machine. Stop and Restart ask
  first."

## How it works

- Every 10 s while open, one Python script (PROBE in model.js) per machine,
  `python3 -I -c` here, through `hc exec --on <m>` for every machine in
  `machines()` whose layout isn't "unavailable". It runs `docker ps -a
  --no-trunc` with a tab-separated format (id, name, image, state, status,
  ports, age, and the compose project, working_dir and service labels) and, in
  parallel, `docker stats --no-stream` (given up after 6 s). Prints
  `{containers}`, `{missing: true}` without docker, or `{error}`. Ports become
  "5432" or "15432->5432", once each.
- Start, Stop, Restart, Resume: `docker start|stop|restart|unpause <id>` on the
  container's machine, then a refresh.
- Logs: `sh -c 'docker logs -f --tail 300 <name>; …; read'`: it follows the
  logs, and when the container isn't running (or stops) it says so and waits
  for Enter, so the output stays readable. Shell: `docker exec -it <name> sh -c
  'bash if there is one, else sh'`. Each runs as `hc run --bg --no-parent
  --no-notify --label docker=<machine>/<name>/<logs|shell>`; a second click on
  a label that is still live goes to that terminal instead of starting another.
- Where it runs: Herdr puts a terminal's pane only beside a pane of the same
  machine ("A terminal's pane must stay on its own machine"). So it runs on the
  machine of the space you look at (`focused()` at the click, its space's
  `machine`): the container's machine → `docker` there directly (`--on` when
  remote); this computer looking at another machine's container → here, as
  `ssh -t -o BatchMode=yes <target> '<the command, quoted>'` (target from `hc
  machine ls --json`); looking at a third machine → on the container's machine
  without a place (a tab in its space).
- The new terminal gets a pane with `terminal.keep`: `place: "right"` of the
  focused pane, else wherever Herdr puts it. Herdr lists a new terminal a
  moment after hc starts it: wait up to 4 s for it in `terminals()`, then for
  its pane. The window stays open, so several can be opened in a row; the
  footer says "Opened the logs of <name> in a pane." (or "in a tab", or "is
  already open: its pane has the focus").

## Install

- Copy `main.js`, `model.js`, `mod.json` to `~/.config/herdr-app/mods/docker/`;
  add `"ctrl-shift-s": "mod.open:docker"`. Each machine needs `python3` and
  `docker` (the user in the docker group); logs and shells of another
  machine's containers need ssh to it without a password.

## Watch out

- `docker stats` keeps dockerd busy for a moment; it runs once per refresh.
- A stopped container's logs print and end at once: hence the wait for Enter.
- Containers of another user's rootless docker don't show.

## Done when

- `herdr-app check` passes.
- Both machines' containers show, grouped by project; "postgres" finds every
  postgres container on both; "Stopped" shows only stopped ones.
- On the `herdr-docker-test` container: Restart and Stop ask, then work; Start
  works; Logs opens a live pane; Shell opens a shell inside it. (Logs of a
  container on 192.168.68.104 opened as a pane in its space on 2026-11-05.)

# Docker tab

Containers of this computer and every connected machine, one panel per machine and compose project.

## What it shows

- `chips` All / Running / Stopped with counts (after the search); the choice stays in `shared("docker.filter")`. "Running" includes paused and restarting.
- A panel per compose project (running ones first, "Other containers" last): title the project, right side `machine · folder · N/M running`. Rows: state dot (`done` running, `working` restarting/paused/health starting, `ansi1` unhealthy/dead, `dim` stopped), name, image · status, ports, cpu · mem (running only), buttons.
- A machine with nothing to list gets one panel with "reading…", "docker isn't installed here.", the error (`ansi1`) or "No containers here.". While searching or filtering, machines with no match are left out.
- Tab count: running containers. Blocked dot: any unhealthy or dead container.

## Search

Every word must appear (case ignored) in machine ("This computer" or its name), project, folder, name, image, service, state, status or ports (":5432"). Overview's "Open in Docker" sets `ui.query` to the machine label.

## Data

Every 10 s per machine (in the background, never blocking Deck's 4 s load): `python3 -I -c PROBE` through `exec ... {on}` (`PROBE` in `docker-model.js`): `docker ps -a --no-trunc` with compose labels, plus `docker stats --no-stream` in parallel (given up after 6 s). Prints `{containers}`, `{missing}` or `{error}`. The machine chip goes `error` only when `exec` rejects.

## Actions

- Start / Resume: run at once. Stop / Restart: `ui.dialog` first. They run `docker <verb> <id>` on the container's machine, then read the machine again; the row's buttons stay disabled meanwhile, the status or failure shows under the row.
- Logs / Shell: `hc run --bg --no-parent --no-notify --label docker=<machine>/<name>/<kind>` running `docker logs -f --tail 300` (waits for Enter when it ends) or `docker exec -it <name> sh -c 'bash or sh'`. Runs on the machine of the focused space; from this computer to another machine over `ssh -t` (target from `hc machine ls --json`). The terminal gets a pane right of the focused one (own tab otherwise). A live terminal with the label is focused instead. Notes: "Opened … in a pane."

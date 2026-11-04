# Machines

How busy this computer and every connected Herdr machine are, and their Docker
containers: CPU, memory, swap, disks, the busiest processes, and each compose
project with logs, start, stop and restart.

## What you see

A window, 600×700, that you can drag anywhere:

- A 32px header: "Machines", "load, memory, disks and containers · every 10
  s" in `dim`, "↻" and "✕".
- A band per machine on `raised`: its name in 12.5px semibold, "up 3d 4h · 8
  cores" in `dim` (or the error in `blocked`).
- Meters: "CPU" (with the load averages), "Memory", "Swap" when there is any,
  and "Disk <path>" per filesystem (/, home, /var/lib/docker when they differ),
  each a 5px bar on `input` with the percent and what it means ("12 GB of 30
  GB", "650 GB free of 950 GB"). `accent` normally, yellow (`ansi3`) from 75%,
  `blocked` from 90%.
- "Busiest now": up to five processes by CPU over the last half second, with
  their memory and command.
- "Docker · N of M containers running", then a line per compose project
  ("other containers" for the rest): a dot, its name, "6 running · 1 exited"
  and its folder. A click unfolds its containers; a project with an unhealthy,
  failed (non-zero exit) or restarting container unfolds by itself, in
  `blocked`, until you fold it.
- A row per container: a dot (green running, yellow starting/restarting/paused,
  red unhealthy/failed, grey stopped), its name without the project prefix, its
  status and CPU · memory, then "Logs", and "Restart" and "Stop" (in
  `blocked`) when running, "Start" when not.
- Stop and Restart open a confirmation box with a `blocked` border: what it
  does to whatever uses the container, "Cancel" and the action.
- The logs panel, 260px: the container's last 120 lines in the terminal font,
  error lines in `blocked`.

## How it behaves

- Every 10 seconds each machine runs one Python script (`PROBE`): `python3 -I
  -c` here, `hc exec --on <machine> -- python3 -I -c` elsewhere. It samples
  `/proc/stat` and every `/proc/<pid>/stat` twice, half a second apart, for
  total and per-process CPU; reads `/proc/meminfo`, `/proc/uptime`,
  `os.getloadavg()` and `statvfs`; then runs `docker ps -a` and `docker stats
  --no-stream`. Docker comes after the CPU sample: `docker stats` keeps dockerd
  busy and would show up as load.
- Filesystems are told apart by size, not `st_dev`: btrfs subvolumes have their
  own device numbers on one filesystem.
- Start, Stop and Restart run `docker start|stop|restart <name>` on that
  machine, then look again. Logs runs `docker logs --tail 120 <name>`.
- Esc closes the confirmation, then the logs, then the window.

## Built from

- `main.js`: the window; `mod.json`: `place: none`, a window overlay.
- Herdr: `machines()`, `exec`, `hc([...])`, `settings().font_family`,
  `props().overlay`/`closeOverlay`.

## Done when

- `herdr-app check` passes.
- Ctrl+Shift+M shows each machine's meters and its compose projects.
- A container that keeps restarting shows its project unfolded in red; "Logs"
  shows why.

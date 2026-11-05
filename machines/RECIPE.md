# Machines

How busy this computer and every connected Herdr machine are: CPU, memory,
swap, disks, the busiest processes, and how many Docker containers run there.
The containers themselves (search, logs, shell, start, stop, restart) are the
docker mod's; "Open in Docker" opens it on that machine.

## What you see

A window, 600×700, that you can drag anywhere:

- A 32px header: "Machines", "load, memory, disks · every 10 s" in `dim`, "↻"
  and "✕".
- A band per machine on `raised`: its name in 12.5px semibold, "up 3d 4h · 8
  cores" in `dim` (or the error in `blocked`).
- Meters: "CPU" (with the load averages), "Memory", "Swap" when there is any,
  and "Disk <path>" per filesystem (/, home, /var/lib/docker when they differ),
  each a 5px bar on `input` with the percent and what it means ("12 GB of 30
  GB", "650 GB free of 950 GB"). `accent` normally, yellow (`ansi3`) from 75%,
  `blocked` from 90%.
- "Busiest now": up to five processes by CPU over the last half second, with
  their memory and command.
- With containers there, a "Docker" line: a dot (`blocked` when one is
  unhealthy, failed with a non-zero exit, restarting or dead, green when one
  runs, else `dim`), "7 running · 20 stopped · 1 unhealthy" (in `blocked` with
  trouble), and "Open in Docker": it puts `{search: <machine label>, at}` in
  `shared("docker.request")` and opens the docker mod's window with
  `openOverlay({mod: "docker", kind: "window", key: "docker", 620×640})`, which
  searches for that machine. Not `mod.open`: it toggles, and would close a
  Docker window that is already open; the same key replaces it in place.
- A footer: what the meter colors mean, and Ctrl+Shift+S for containers.

## How it behaves

- Every 10 seconds each machine runs one Python script (`PROBE`): `python3 -I
  -c` here, `hc exec --on <machine> -- python3 -I -c` elsewhere. It samples
  `/proc/stat` and every `/proc/<pid>/stat` twice, half a second apart, for
  total and per-process CPU; reads `/proc/meminfo`, `/proc/uptime`,
  `os.getloadavg()` and `statvfs`; then `docker ps -a` for each container's
  state and status (no `docker stats`: it keeps dockerd busy every time).
- Filesystems are told apart by size, not `st_dev`: btrfs subvolumes have their
  own device numbers on one filesystem.
- Nothing here changes a machine. Esc closes the window.

## Built from

- `main.js`: the window; `mod.json`: `place: none`, a window overlay.
- Herdr: `machines()`, `exec`, `hc([...])`, `openOverlay`, `setShared`,
  `props().overlay`/`closeOverlay`.

## Done when

- `herdr-app check` passes.
- Ctrl+Shift+M shows each machine's meters and its container counts.
- "Open in Docker" on 192.168.68.104 opens the Docker window searching for
  "192.168.68.104".

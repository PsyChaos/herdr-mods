# Overview

One panel per machine (`here` first), the old Machines mod folded in.

## Shows

- cores, cpu (meter, history), memory (meter, history, swap %), net, agents: from the shared probe (`probe.js`, 5 s).
- From Machines, per machine: `swap` meter (when there is swap), one `disk` meter for `/`, `~` and `/var/lib/docker` (deduped by filesystem size; falls back to the probe's `/`), a `procs` table of the 6 busiest processes (name, cpu, mem), and a `docker` line: dot (red when something is unhealthy, failed, restarting or dead; green when one runs), counts like `7 running · 20 stopped · 1 unhealthy`.
- Meters turn yellow from 60 % and red from 85 % (Deck's bands).

## Data

Extras run in their own `exec` (`python3 -I -c` from `machines-model.js`, `on` the machine, 8 s timeout) every 10 s, in the background; `load` returns at once. Docker counts use `timeout 2 docker ps -a` (no `docker stats`). A machine's chip goes red only when that exec rejects; a script or docker problem shows as an `extras:` line in the panel. Pure parts are tested by `node deck/machines-model.test.mjs`.

## Actions

- "Open in Docker": sets `docker.ui.query` to the machine name (`This computer` for `here`, as the old mod searched) and switches to the docker tab. Nothing here changes a machine.
- Click or Enter on a panel selects it / goes to the agents tab.

Search does not filter this tab.

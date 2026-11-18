# Ports tab

Which program or container listens on which TCP port, on this computer and on
every connected machine. Ported from the old ports mod.

## Shows

- `chips` **common / show all**: common is containers and programs whose folder
  is under `~/`, below port 32768; show all adds system ports and ports above
  32768. The tab count is the number of common ports.
- One panel per machine (this computer first), `N ports`, "reading…" or the
  read error on the right. A row: `:port`, program or container ("system" when
  root's), folder (or command), `network` when it listens beyond loopback, the
  Herdr terminal that started it (`HC_TERMINAL_ID`), row buttons.
- Row buttons: **open** (Herdr's browser mod, through that machine, via
  `browser.request`), **my browser** (xdg-open; another machine's port through an
  ssh tunnel run as a Herdr terminal labelled `tunnel=<machine>:<port>`, found
  again from `terminals()`), **close tunnel** (`hc kill` + `hc rm`), **terminal**
  (`pane.focus` or `terminal.peek`), **stop**.
- Open and my browser are absent for ports that never serve a page (ssh, mail,
  DNS, databases, ...).

## Data

Every 10 s per machine one `python3 -I -c` PROBE (`hc exec --on` elsewhere):
`ss -ltnpH`, `/proc/<pid>/{cmdline,cwd,environ}`, `docker ps`. The read runs in
the background; `load` answers from the cache. A machine is `error` only when
its exec fails; a failing script shows in its panel.

## Actions

- **Stop** asks first (`ui.dialog`). A process gets `kill -s TERM` only if
  `ss "sport = :N"` still shows its pid; a container gets `docker stop`. After
  2.5 s the machine is read again; if the same pid listens, a "Still listening"
  note and a **Force stop (kill -9)** dialog follow.
- Results and errors are `ui.note` lines.

## Search

Words split on whitespace, each must appear in `:port`, container, program,
folder, command, terminal (where, name) or machine. Search looks through hidden
ports too; machines with no match drop out. Enter on a row goes to its terminal.

Pure logic: `deck/ports-model.js` (`node deck/ports-model.test.mjs`).

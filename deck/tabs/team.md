# Team tab

The coding agents working in each repository on every Herdr machine, and what
they said to each other. Chips switch between **agents** (count) and
**messages** (unread count). The tab shows a blocked dot while any message is unread.

## Agents

One panel per repository (title: name; right: machine, worktrees, agents), the
busiest and those with warnings first. Inside: "Introduce" (2+ agents), warnings
with "Tell them", then each worktree: branch, folder, "N commits on top of
<base>", its agents (status dot, program, address, space / tab · title) and its
changed files (M A D R U, C = changed by the branch's commits; six show, then
"N more" / "show fewer"). Agents outside any git folder sit in their own panel.
Enter or a click on an agent goes to its terminal.

Warnings: 2+ agents in one folder; a file changed in 2+ worktrees. "Tell them"
runs `hc send` to each agent concerned (texts in `deck/team/messages.js`).
"Introduce" runs `herdr-team introduce` on the repository's machine.

## Messages

Left, a panel per project (repository with a `herdr-team` log) with its
conversations (one per pair of agents, "Everyone" for messages to all), last
time and unread badge; right, the chosen conversation, oldest first (last 30,
"N earlier" shows the rest), a day line where the date changes. j/k or a click
choose a conversation. "Clear project" asks first (dialog), then empties the log
(`: > log` on its machine) and forgets its read counts.

Unread counts: `shared("team.read")` (conversation key -> messages seen). A
conversation on screen for 8 s, or one you click, is read.

## Data and cadence

Every 8 s (Deck ticks every 4 s; the tab returns its cache between reads) one
Python script per machine (`deck/team/model.js` PROBE, `python3 -I -c`, via
`hc exec --on` for another machine) reads each agent's git worktree and each
repository's log. A chip turns red only when exec to a machine fails; a script
error shows as a red line in the tab.

## Search

`/` words (all must match, case ignored). Agents: repository, machine, branch,
folder, agent (address, program, space, tab, title, status) or file; words found
only in file names narrow the file list; warnings hide. Messages: project, date,
time, sender, receiver, text or conversation name; only matching messages show.

Pure logic and its test: `deck/team/model.js`, `inbox.js`, `messages.js`,
`node deck/team/model.test.mjs`. The `herdr-team` command stays at `team/herdr-team`.

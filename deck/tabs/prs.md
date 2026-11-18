# prs tab

Open pull requests and the latest CI runs of every GitHub repository open in a Herdr space, on this computer and every connected machine (ported from the `ci` mod). Code: `tabs/prs.js`, pure logic and test: `prs-model.js`, `prs-model.test.mjs`.

## What it shows

- A panel per space (sidebar order, title = space name, right = `machine · branch`); folders that belong to no space go under "Other folders". A button in the panel's first line runs `space.select`.
- Per repository: `owner/repo`, its folder, then a table: state dot (failing `ansi1`, running `working`, passed `done`, none dim), `#N title` (`muted` for drafts), details (branch, author, draft, checks "failed: e2e", "2 of 6 checks running", review, age), row buttons.
- A branch without an open PR shows its workflows' latest runs as rows.
- Bot PRs (Dependabot, Renovate) fold into one `▸ N bot PRs (…)` row per repository; a click unfolds. While searching, matching bot PRs show unfolded.
- A footer panel: "Notifications on/off" and how many repositories have nothing open.
- Tab count = open PRs; the blocked dot = any failing PR.

## Data

Per machine one python script (`PROBE`): `python3 -I -c` here, `hc exec --on <machine>` elsewhere. It finds each folder's git top and github.com origin and asks that machine's `gh`: `gh pr list --state open` (with checks) and `gh run list --branch <checked-out branch>`, 8 repositories at a time. Read-only. Every 60 s, every 20 s while something runs (Deck's 4 s load returns the cache; fetches run in the background). A machine chip goes red only when the machine can't be reached; `gh` not logged in shows as a red line in the tab.

## Actions (row buttons)

- open: the PR or run in your browser (`openUrl`); clicking the row does the same.
- GitHub: the repository's page.
- log (failed rows): `gh run view <id> --log-failed` on that machine, last 60 lines in a log view under the row, HTTP 410 says the log expired. Pressing again closes it. Under the log: **Copy** (agent message to the clipboard with `wl-copy`/`xclip`/`pbcopy`) and **Send to an agent** (puts the message in the agent's input, not sent: copy, `pane.focus`, 250 ms, `terminal.paste`). One agent in the repository's space gets it at once; otherwise a chips row picks one, the space's agents first.
- Copy and Send live under the log (they need its text), not on the row.

## Search

`/` keeps rows where every word appears in space, repository, folder, machine or item (number, title, branch, author, review, state, check names; for runs branch, workflow, title, state).

## Notifications (watcher)

`watch(cx)` runs in a hidden copy of Deck (`props.watch = "prs"`, kept frameless 2×2 window, key `deck-ci-watch`). It polls and calls `notify` on each finish (passed 8 s, failed until closed, cancelled warning); the first answer per machine only records state. Heartbeat `{overlay, at}` every 60 s in `shared("deck.ci-watch")`; the tab starts a watcher when it is older than 3 min and notifications aren't off. Off is `shared("deck.ci-watch").off`, copied from `shared("ci.watch")` on first run.

Notification action is the mod command `deck.prs`, delivered to the watcher's `nextCommand()`: it sets `shared("deck.tab")` and `openOverlay`s Deck's own window spec (never toggles).

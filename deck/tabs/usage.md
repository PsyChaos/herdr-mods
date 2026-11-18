# Usage tab

How full each provider's rate limits are, on this computer and on every Herdr machine.

## What it shows

One panel per machine (`this computer` first). A provider is a row: name (error in `blocked`), plan, then one line per window: label, a 24-cell `meter`, percent, reset time (`16:39` today, `Nov 9` another day, `passed` once past). Providers without limit windows (opencode) show their `totals` (today/week tokens) instead. At the end of the first line a dim note: `stale` when every window is stale (those meters are faded), `N ago` when the reading is over 30 minutes old, `connecting…` while a machine loads. A reader that fails shows its error in the row; `skip: true` hides the provider on that machine.

## Data

Readers are `usage/sources/<provider>.sh`, each printing one JSON line (`usage/CONTRACT.md`). This computer runs the file; another machine gets the script text through `exec ... {on}`, so nothing is installed there. Read every 120 s in the background (cached in module scope, so closing Deck keeps it) and on refresh. The machine chip is red only when a machine cannot be reached; a broken reader shows in its row. Pure parts: `usage-model.js` (`node deck/usage-model.test.mjs`).

## Actions

- Refresh (the round arrow in the first panel's title row): reads everything now; disabled while a read runs.

## Search

`/` keeps providers whose machine (`here`, `this computer` or its name), provider, label, plan or error contains every word typed. The old board had no search; these are the words it showed.

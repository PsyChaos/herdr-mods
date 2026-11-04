# PRs & CI

The open pull requests and the latest CI runs of every GitHub repository open
in a Herdr space, on this computer and on every connected machine, grouped by
space. A notification comes when a PR's checks or a branch's run finish, and a
failed run's log is one click away, ready to hand to an agent.

## What you see

A window, 620×640, that you can drag anywhere:

- A 32px header: "PRs & CI", then in 10px `dim` "N open PRs · N failing · N
  running" ("N of M PRs match" while searching), "↻" and "✕".
- A search input, placeholder "Search: space, repo, #12, title, branch,
  author, check…", with the keyboard as soon as the window opens.
- A band per space on `raised`, in the sidebar's order: its name in semibold,
  its machine and branch in `dim`. Clicking it selects that space.
- Under it, per repository: `owner/repo` in semibold and its folder in `dim`;
  when the checked-out branch has no open PR, a line with the branch and a dot
  per workflow's latest run (clicking a failed one shows its log, any other
  opens it on GitHub).
- A row per PR: a dot (green passed, red failed, yellow running, grey no
  checks), `#N title` (`muted` for drafts), and under it in 10px the branch,
  author, "draft", the checks ("failed: e2e, lint" in `blocked`, "2 of 6
  checks running", "6 checks passed", "no checks"), the review decision and
  how long ago it changed. "Open", and "Log" when a check failed in GitHub
  Actions.
- Bot PRs (Dependabot, Renovate) fold into one "▸ 13 bot PRs (dependabot) · 13
  failing" line per repository; a click unfolds them.
- The log panel, 250px, under the list: "Log", the PR or workflow and the
  failed job / step, what the last button did in `accent`, "Send to an agent",
  "Copy", "GitHub", "✕", and the last 60 lines in the terminal font, error
  lines in `blocked`. "Send to an agent" with several agents opens a list of
  them under the bar, the repository's space first ("this space" in `accent`).
- A footer line: grouped by space, how many repositories have nothing open.

## How it behaves

- The folders come from `spaces()` and `panes()`: each pane's live folder in
  a space's tabs (its first pane first, as the sidebar shows it), then the
  folder the space was made in. A repository shows under the space whose
  folder found it with the best rank; anything else under "Other folders".
- Each machine runs one Python script (`PROBE`) with its folders: `python3 -I
  -c` here, `hc exec --on <machine> -- python3 -I -c` elsewhere. It finds each
  folder's git top and `github.com` origin, then with that machine's `gh`:
  `gh pr list --state open --json …,statusCheckRollup` and `gh run list
  --branch <checked-out branch>` (the latest run per workflow), 8 repositories
  at a time. Nothing is written to GitHub.
- It refreshes every 60 seconds, every 20 while a run or check is going.
- A PR's state is its checks rolled up: any failure, else anything running,
  else passed. A run that finishes between two looks (a new run id) counts too.
  Each finish gives one `notify` ("passed" success 8 s, "failed" error until
  closed, "was cancelled" warning) whose action opens this window. The first
  answer from each machine only records where things stand. Notifications come
  only while the window is open.
- "Log" runs `gh run view <id> --repo <repo> --log-failed` on that machine,
  drops timestamps and colours, and keeps the last 60 lines. An expired log
  (HTTP 410) says so.
- "Copy" copies a message for an agent: what failed, the URL, the failed step
  and the log lines (or why there is no log), ending with "Find the cause and
  fix it.", with `wl-copy`, `xclip` or `pbcopy`.
- "Send to an agent" puts that message in an agent's input without sending it.
  With one agent (`agents()`) in the repository's space it goes there; with more
  you pick one. It copies the message, runs `pane.focus {pane}` on the agent,
  then `terminal.paste` 250 ms later. Enter stays yours. `hc send` can't do
  this: it always presses Enter.
- "Open" and "GitHub" open the page in your own browser (`xdg-open`, `open`
  on macOS), started with `setsid -f` so it doesn't hang on Herdr's `exec`.
  Your browser has your GitHub login, which private repositories need.
- The search keeps rows where every word appears in the space, repository,
  folder or item (number, title, branch, author, review, state, check names).
  Bot PRs that match show unfolded. Esc clears the search, then closes the log,
  then the window.

## Built from

- `main.js`: the window; `mod.json`: `place: none`, a window overlay.
- Herdr: `spaces()`, `panes()`, `agents()`, `machines()`, `exec`, `hc([...])`,
  `notify`, `run("space.select" | "pane.focus" | "terminal.paste")`, `settings().font_family`, `window().platform`,
  `props().overlay`/`closeOverlay`.
- gpui-base `InputState` + `Input`.

## Watch out

- A space's `folder` is where it was made, not where it works now; panes'
  `cwd` is.
- `exec` waits for what it starts. A browser opened straight from it can be
  held up; detach it.
- `gh run view --log-failed` exits non-zero on an expired log; the output of a
  pipe hides that unless the script keeps the exit code.
- `gh` must be logged in on each machine (`gh auth login`); the probe says so
  when it isn't.

## Done when

- `herdr-app check` passes.
- Ctrl+Shift+R lists each space with its repositories' open PRs and checks.
- Pushing to a PR branch while the window is open gives a notification when
  its checks finish.
- "Log" on a failed PR shows the failed step's last lines; "Send to an agent"
  leaves the message in that space's agent's input, unsent.

# Agent team

Lets the coding agents working in one repository talk to each other, whether
they are on the same branch or in different worktrees, and shows you who works
where and what they said.

Two parts:

- `herdr-team`, a command for agents (installed in `~/.local/bin` on every
  Herdr machine). An agent runs `herdr-team who` to see the other agents in
  its repository and `herdr-team say <address|all> "…"` to message them: the
  message is typed into the other agent's input and submitted, so it arrives
  as a new turn. `herdr-team log` shows what was said.
- The Agent team window (Ctrl+Shift+D): the agents per repository and
  worktree, the files each worktree changed, warnings about clashes, the
  messages, and "Introduce", which tells every agent of a repository who the
  others are and how to reach them.

## herdr-team

- `who`: the agents in the caller's repository, one line each: address,
  program, status, branch, worktree folder, task label, "<- you" for the
  caller. "No other agent works in this repository right now." when alone.
- `say <to> <message>`: `<to>` is an address from `who` or `all` (everyone but
  the caller). Each target gets, through `hc send <address> <text>`:
  `[team] t9 (claude-code, branch main) to you: <message> Reply with:
  herdr-team say t9 "..." (only if you have something to add).`
  Herdr shows it to the receiver inside `<hc from="t9">`. `hc send` waits while
  a person types in that terminal and refuses an agent waiting on a dialog; that
  target is reported "NOT delivered: <why>" and the command exits 1. Sends run
  in parallel, 120 s each at most.
- `log [N]`: the last N (20) lines of the log.
- `setup`: writes the rules (RULES in the script) into the instructions file of
  each agent installed on this machine, only where they are missing; edited or
  existing rules are left alone. Claude Code: `~/.claude/HERDR-TEAM.md` and an
  `@HERDR-TEAM.md` line in `~/.claude/CLAUDE.md` (created if missing). Codex
  (`$CODEX_HOME` or `~/.codex`), OpenCode (`~/.config/opencode`) and Pi
  (`~/.pi/agent`): a block between `<!-- herdr-team rules … -->` and
  `<!-- /herdr-team -->` at the end of their `AGENTS.md`, when the folder exists.
  Prints "<file>: rules written" or "rules already there" per file.
  Then the session-start hook: a `SessionStart` entry
  `{"type": "command", "command": "herdr-team hook", "timeout": 15}` added to
  `~/.claude/settings.json` and to Codex's `hooks.json` (created if missing),
  unless "herdr-team hook" is already in their `SessionStart`; the rest of the
  file is kept, written back as 2-space JSON; a file that isn't JSON is left
  alone with a note. Prints "session-start hook added" or "already there".
  OpenCode has no such hook: when `~/.config/opencode` exists, `setup` writes
  OPENCODE_PLUGIN to `~/.config/opencode/plugins/herdr-team.js`, and rewrites
  it while its first line still starts with "// herdr-team plugin for
  OpenCode" ("changed by you, left alone" otherwise). The plugin (OpenCode 2.x:
  default export `{id, setup(ctx)}`) does nothing without `HC_TERMINAL_ID`;
  else, on `ctx.session.hook("context")`, it runs `herdr-team hook` (PATH, then
  `~/.local/bin`) once per sessionID in `ctx.location.directory`, and pushes
  its `additionalContext` to `event.system` on every request of that session.
- `hook`: for those hooks. Reads the event (JSON on stdin) for its `cwd`; with
  `HC_TERMINAL_ID` set and `cwd` in a git repository it prints
  `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext":
  "[herdr-team] You run in a Herdr terminal. " + the who lines}}`, plus
  "Tell them before you edit files they may be touching; …" when others work
  there, and records the caller in members.json like any command. Otherwise, or
  on any error, it prints nothing and exits 0. JSON, not plain text: Codex
  takes stdout starting with "[" for JSON and fails the hook.
- The rules: when `HC_TERMINAL_ID` is set, run `herdr-team who` when starting
  work in a repository and tell the others before editing files they may touch;
  read the log and ask before editing a file another agent named or reverting,
  stashing, resetting, rebasing, force-pushing or deleting files it didn't
  change; answer messages that need it, don't only acknowledge, keep them short.
  Sub-agents that others must reach start as Herdr terminals:
  `hc run --bg --cwd <worktree> --label task="<name>" claude|codex "<task>"`,
  followed with `hc wait`/`hc read` and messaged with `herdr-team say`; the
  built-in subagent tool is for short lookups.
- `introduce`: `setup`, then sends every other agent in the repository a
  message listing the others (address, program, branch, folder), the commands,
  the rules in short and the `hc run` line, and logs
  "(introduced N agents to each other)". Agents already running read their
  instructions file only in their next session, hence the message.
- The log is `<git common dir>/herdr-team.md` (every worktree shares it, git
  never commits it): `- 2026-11-04 20:37 t3w(claude-code) → t3x(codex): text`,
  with "(not delivered to …)" when a send failed. Each repository it writes a
  log for is added to `~/.local/state/herdr-team/repos.json`.
- Agents are this machine's live terminals in `hc ls --json` that report a
  status (the program from it, else `hc ls`'s `agent`; state "-" when none:
  Codex never reports one), or whose program is a known agent (claude, codex, opencode, pi,
  gemini, aider, copilot, amp, goose, cursor-agent) and hasn't reported yet.
  Each one's folder: where it last ran herdr-team
  (`~/.local/state/herdr-team/members.json`, `{address: worktree}`, pruned to
  live terminals), else its foreground process's folder (`hc get --json`).
  An agent started one folder up joins its repository once it runs any
  herdr-team command there. The caller is `$HC_TERMINAL_ID`.
- Repository = git common dir, so all worktrees of one repository are one team.
  Only this machine: a repository's other clones on other machines are another
  team.

## The window

A window, 640×700, that you can drag anywhere:

- A 32px header: "Agent team", the tabs "Agents" and "Messages" ("Messages ·
  N new" with unread messages), then in 10px "N agents · N repos · N warnings"
  (`blocked` when there are warnings), "↻" and "✕".
- A search input with the keyboard as soon as the window opens. Every word must
  appear (case ignored). Under "Agents" it keeps the worktrees whose repository,
  machine, branch, folder, agents (address, program, space, tab, title, status)
  or files match; words found only in file names narrow the file list to those
  files; warnings hide while searching. Under "Messages" it keeps the
  conversations with a matching message (project, date, time, sender, receiver,
  text, conversation name), showing only those messages.

### Agents

- A band per repository on `raised`: its name in semibold, then its machine,
  "N worktrees · N agents" in `dim`, and "Introduce" (with 2+ agents; "Sending…"
  meanwhile). Repositories with warnings come first.
- Each warning in a box with a `blocked` border, and "Tell them":
  - "N agents share <folder>: git can't tell whose change is whose."
  - "<file> (or N files) changed in N worktrees (<branches>): their merges will
    conflict.", with up to six file names below.
- Each worktree: its branch, then in `dim` its folder and "N commits on top of
  <base>". Its agents: status dot (theme `working`/`blocked`/`done`/`idle`),
  program, address in `accent`, "space / tab · title"; a click focuses its pane.
  Then its files, one letter each: M changed, A new, D deleted, R renamed,
  U unmerged, C changed by the branch's commits (dim). Six show, then "N more" /
  "show fewer".
- "Not in a git repository" (or "Reading their folders…") with the other agents.

### Messages, an inbox

- Left, 230px: each project (repository with a log, newest activity first) on
  `raised` with its machine and an unread badge (`accent`), and under it its
  conversations, newest first: one per pair of agents ("t3w Claude ↔ t3x
  Codex", "you" for the user) and "Everyone" for messages sent to all. A
  conversation shows its last time, an unread badge (its name semibold), and
  "sender: last message" in `dim`. A click opens it.
- Right: the open conversation (the clicked one, else the newest): its name,
  "project · machine · N messages", "Clear project" ("Sure? Clear all of
  <project>" on the first click). Its messages oldest first, the last 30
  ("N earlier" shows the rest), a date line where the day changes, each on a
  `raised` card: sender in semibold, "→ receiver" (or "→ everyone") in `dim`,
  time, then the text, wrapped.
- Unread: `shared("team.read")`, conversation key → messages seen. A click
  marks a conversation read, and so does the 8-second refresh for the one on
  screen. Clearing a project forgets its counts.

### Both

- A footer: the last result ("Sent to N agents.", or `blocked` "Not delivered:
  …"), else a line on what herdr-team and "Introduce" do.
- Esc clears the search, then closes the window.

## How the window works

- Agents: `agents()`; machine: their space's `machine`; folder: the pane's
  `cwd`, unless members.json on that machine names one.
- One Python script per machine (`python3 -I -c`, through `hc exec --on <m>`
  for another), every 8 s while open, with `[[address, folder], …]`. Per folder:
  `git rev-parse --show-toplevel` and `--git-common-dir`, `branch
  --show-current`, `status --porcelain=v1 -z --untracked-files=all` (400 files
  at most), and on a branch other than the default (`origin/HEAD`, else
  origin/main, origin/master, main, master) the files changed since the
  merge-base and the commit count. Git runs with `--no-optional-locks`, without
  fsmonitor. It reads the log (last 20 000 characters) of each repository it
  found and of each one in `~/.local/state/herdr-team/repos.json` that still
  exists, so the inbox keeps projects whose agents ended. Every reachable
  machine (`machines()`) is read, with or without agents.
- A log line: `- 2026-11-04 20:37 t3w(claude-code) → t3x(codex): text`
  (`user` for a person, `all` for everyone; older lines have no programs). A
  program seen once names that address in the whole project.
- Warnings: a worktree with 2+ agents; files in 2+ worktrees' lists (uncommitted
  or committed on the branch), files with the same worktrees in one warning.
- "Introduce" runs `herdr-team introduce` on the repository's machine, in its
  first worktree (`sh -c`, `~` expanded, `~/.local/bin/herdr-team` when it isn't
  on PATH), and shows "Introduced N agents. Rules added to <files>." or what
  failed. "Tell them" runs `hc send <machine/address> <text>` for each agent
  (messages.js): the other agents and files, and the herdr-team commands.
- "Clear" runs `: > <log>` on its machine.

## Install

- Copy `herdr-team` to `~/.local/bin/` on every Herdr machine (`chmod +x`); it
  needs `python3`, `git` and `hc`. Run `herdr-team setup` there once, in any
  folder (it writes only to the home folder's agent settings), and again after
  installing another agent. Codex asks once to trust the hook.
- Copy `main.js`, `model.js`, `inbox.js`, `inbox-view.js`, `messages.js`, `mod.json` to
  `~/.config/herdr-app/mods/team/`; add `"ctrl-shift-d": "mod.open:team"`.

## Watch out

- An agent's process folder is where it started, often one folder above the
  repository; members.json fixes that once it uses herdr-team.
- Two agents in one folder can't be told apart by git: files show under the
  folder, not under an agent.
- Agents replying to every message would loop: the texts ask them not to.
- Agents started with Claude Code's own subagent tool aren't terminals and
  can't be reached; ones started with `hc run` can.

## Done when

- `herdr-app check` passes.
- Two agents in one repository: A runs `herdr-team say <B> "ping, answer with
  pong"`, B gets it as a new message and answers, A gets "pong", and the window's
  Messages shows the three lines. (Done 2026-11-04 with two Claude Code agents.)
- "Introduce" makes each agent of a repository able to run `herdr-team who` and
  see the others.
- A new Claude Code session, after `setup`, quotes the rules and runs
  `herdr-team who` on its own. (Done 2026-11-04.)
- A new Claude Code, Codex and OpenCode (`run` and the TUI, on both machines)
  session in a repository, asked not to run anything, quote the
  "[herdr-team] …" note. (Done 2026-11-05.)

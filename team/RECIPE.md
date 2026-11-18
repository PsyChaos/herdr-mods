# Agent team

Lets the coding agents working in one repository talk to each other, whether
they are on the same branch or in different worktrees, and shows you who works
where and what they said.

Two parts:
`herdr-team`, a command for agents (installed in `~/.local/bin` on every
Herdr machine). An agent runs `herdr-team who` to see the other agents in
its repository and `herdr-team say <address|all> "…"` to message them: the
message is typed into the other agent's input and submitted, so it arrives
as a new turn. `herdr-team log` shows what was said.

The window that shows who works where and what they said is Deck's **team**
tab ([`deck/tabs/team.md`](../deck/tabs/team.md)).

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

## Install

- Copy `herdr-team` to `~/.local/bin/` on every Herdr machine (`chmod +x`); it
  needs `python3`, `git` and `hc`. Run `herdr-team setup` there once, in any
  folder (it writes only to the home folder's agent settings), and again after
  installing another agent. Codex asks once to trust the hook.

## Watch out

- An agent's process folder is where it started, often one folder above the
  repository; members.json fixes that once it uses herdr-team.
- Agents replying to every message would loop: the texts ask them not to.
- Agents started with Claude Code's own subagent tool aren't terminals and
  can't be reached; ones started with `hc run` can.

## Done when

- Two agents in one repository: A runs `herdr-team say <B> "ping, answer with
  pong"`, B gets it as a new message and answers, A gets "pong". (Done
  2026-11-04 with two Claude Code agents.)
- A new Claude Code session, after `setup`, quotes the rules and runs
  `herdr-team who` on its own. (Done 2026-11-04.)

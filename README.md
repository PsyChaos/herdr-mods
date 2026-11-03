# herdr-mods

Mods for the [Herdr](https://herdr.dev) app, for working with several coding
agents at once.

| Mod | What it shows |
|---|---|
| [`task-board`](task-board/) | **Task board.** Which agent hands out work, which tasks it started, which provider runs each one, for how long, and how it ended. |
| [`usage-board`](usage-board/) | **Usage.** How full each provider's 5-hour and weekly limits are on every Herdr machine, and when they reset. Claude Code and Codex included. |
| [`browser`](browser/) | **Browser.** Opens a web page in a pane beside your agents. Pick another Herdr machine and its `localhost` opens, no port forwarding. |

<p>
  <img src="task-board/preview.png" alt="Task board" width="258">
  <img src="usage-board/preview.png" alt="Usage board" width="258">
  <img src="browser/preview.png" alt="Open in browser" width="300">
</p>

## Install

```sh
git clone https://github.com/PsyChaos/herdr-mods
cp -r herdr-mods/task-board herdr-mods/usage-board herdr-mods/browser ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/task-board
herdr-app check ~/.config/herdr-app/mods/usage-board
herdr-app check ~/.config/herdr-app/mods/browser
```

The browser mod also needs [terminal-browser](https://github.com/zenbu-labs/terminal-browser)
on this computer (Linux or macOS):

```sh
curl -fsSL https://terminal-browser.sh/install | bash
```

Then add the keys from each mod's `keys.json` to `~/.config/herdr-app/keys.json`
(check you don't already use them):

```json
"global": {
  "ctrl-shift-g": "mod.open:task-board",
  "ctrl-shift-j": "mod.open:usage-board",
  "ctrl-shift-u": "mod.open:browser"
}
```

`Ctrl+Shift+G` and `Ctrl+Shift+J` now open each panel as a window you can drag
anywhere; it comes back after a restart until you close it. `Ctrl+Shift+U`
asks for an address to open.

An agent in Herdr can do all of this for you: ask it to add the mods from this
repository. Each folder has a `RECIPE.md` it can follow.

### Dock them in the sidebar (optional)

Herdr's own layouts are read-only, so dock the panels in a copy of the main
layout:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-main"}'
```

In `~/.config/herdr-app/layouts/my-main.json`, add these blocks to the
`children` of the node with `"id": "sidebar-lists"` (under Spaces and Agents):

```json
{ "id": "tasks", "type": "block", "size": { "weight": 1 }, "min": 90, "content": { "mod": "task-board" } },
{ "id": "usage", "type": "block", "size": { "weight": 1 }, "min": 90, "content": { "mod": "usage-board" } }
```

Each docked panel gets "⇄" to move between the left sidebar and the right of
the work area, and "–" to hide it. To toggle them with keys in that layout:

```json
"layout:my-main": {
  "ctrl-shift-g": "layout.toggle:tasks",
  "ctrl-shift-j": "layout.toggle:usage"
}
```

`Ctrl+Shift+L` switches back to Herdr's own layout. A copied layout doesn't
receive Herdr's later changes to the main layout.

## Using the task board

A task is any terminal started with a `task` label, usually by an agent that
splits work among others:

```sh
hc run --bg --name review --label task="Review the auth module" --label role=reviewer \
  codex "Review src/auth. Report with hc send $HC_TERMINAL_ID when done."
```

Tell your lead agent to label the work it hands out this way. Click a running
task to jump to its agent.

## Using the browser

`Ctrl+Shift+U`, type an address (`example.com`, `localhost:3000`, or just
`3000`) and press Enter. The page opens in a pane to the right; Ctrl+Q in the
browser closes it.

"Load through" starts as the machine of the space you're in. The browser always
runs on this computer, where Herdr draws it, so it stays smooth. With another
machine chosen, terminal-browser loads pages through it over ssh (`--ssh`), so
`localhost` means that machine: a dev server running there opens as it is. This
needs ssh to that machine without a password prompt.

## Adding a provider to the usage panel

Put a script in `usage-board/sources/<provider>.sh` that prints one line of
JSON as described in [`CONTRACT.md`](usage-board/CONTRACT.md). The panel
picks it up on the next refresh and runs it on every machine.

## What these mods do on your machine

- **task-board** runs `hc get` and `hc rm` on finished task terminals and
  keeps up to 50 finished tasks in Herdr's shared state. No network access.
- **usage-board** runs its `sources/*.sh` scripts every 2 minutes, here and
  on each connected Herdr machine (the script text is sent and run there;
  nothing is installed).
  - `claude.sh` reads your Claude Code login (`CLAUDE_CONFIG_DIR` or
    `~/.claude*/.credentials.json`) and sends its access token only to
    `https://claude.ai/api/oauth/usage`, the endpoint Claude Code's `/usage`
    uses. The token is never printed, stored or refreshed. This endpoint is not
    documented and may change.
  - `codex.sh` only reads `~/.codex/sessions`. No network access.

Both need `python3`.

- **browser** runs `terminal-browser` on this computer when you open a page,
  with its usage statistics turned off (`DO_NOT_TRACK=1`). For another
  machine it connects with ssh. On its first start terminal-browser adds a
  skill for agents to `~/.claude/skills`, `~/.codex/skills` and
  `~/.agents/skills`; delete those links if you don't want agents to use it.

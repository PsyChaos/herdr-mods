# herdr-mods

Two panels for the [Herdr](https://herdr.dev) app, for working with several
coding agents at once. Their interface text is Turkish.

| Mod | What it shows |
|---|---|
| [`gorev-panosu`](gorev-panosu/) | **Task board.** Which agent hands out work, which tasks it started, which provider runs each one, for how long, and how it ended. |
| [`kullanim-panosu`](kullanim-panosu/) | **Usage.** How full each provider's 5-hour and weekly limits are on every Herdr machine, and when they reset. Claude Code and Codex included. |

<p>
  <img src="gorev-panosu/preview.png" alt="Görev panosu" width="260">
  <img src="kullanim-panosu/preview.png" alt="Kullanım panosu" width="268">
</p>

## Install

```sh
git clone https://github.com/PsyChaos/herdr-mods
cp -r herdr-mods/gorev-panosu herdr-mods/kullanim-panosu ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/gorev-panosu
herdr-app check ~/.config/herdr-app/mods/kullanim-panosu
```

Then add the keys from each mod's `keys.json` to `~/.config/herdr-app/keys.json`
(check you don't already use them):

```json
"global": {
  "ctrl-shift-g": "mod.open:gorev-panosu",
  "ctrl-shift-j": "mod.open:kullanim-panosu"
}
```

`Ctrl+Shift+G` and `Ctrl+Shift+J` now open each panel as a window you can drag
anywhere; it comes back after a restart until you close it.

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
{ "id": "tasks", "type": "block", "size": { "weight": 1 }, "min": 90, "content": { "mod": "gorev-panosu" } },
{ "id": "usage", "type": "block", "size": { "weight": 1 }, "min": 90, "content": { "mod": "kullanim-panosu" } }
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

## Adding a provider to the usage panel

Put a script in `kullanim-panosu/sources/<provider>.sh` that prints one line of
JSON as described in [`CONTRACT.md`](kullanim-panosu/CONTRACT.md). The panel
picks it up on the next refresh and runs it on every machine.

## What these mods do on your machine

- **gorev-panosu** runs `hc get` and `hc rm` on finished task terminals and
  keeps up to 50 finished tasks in Herdr's shared state. No network access.
- **kullanim-panosu** runs its `sources/*.sh` scripts every 2 minutes, here and
  on each connected Herdr machine (the script text is sent and run there;
  nothing is installed).
  - `claude.sh` reads your Claude Code login (`CLAUDE_CONFIG_DIR` or
    `~/.claude*/.credentials.json`) and sends its access token only to
    `https://claude.ai/api/oauth/usage`, the endpoint Claude Code's `/usage`
    uses. The token is never printed, stored or refreshed. This endpoint is not
    documented and may change.
  - `codex.sh` only reads `~/.codex/sessions`. No network access.

Both need `python3`.

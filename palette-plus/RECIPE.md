# Palette plus

Herdr's own command palette (Ctrl+Shift+P) with a "Mods" group: every mod you
open with a key, and the mods from this repository, by name with their key.

## What you see

Herdr's palette, unchanged, with "Mods" right after "Recent": "Ports",
"PRs & CI", "Machines", "Open in browser", "Task board", "Usage" and any other
`mod.open:<name>` key in `keys.json`, each with its key. Typing finds them too
("docker" finds Machines, "kill" finds Ports).

## How it behaves

- Herdr writes its palette to `~/.config/herdr-app/frame/palette/main.js` on
  every start, and a mod can't import a file outside its own folder (a symlink
  is refused too). So `sync.sh` copies it here as `base.js` and exports its
  `entries`, `fuzzy` and `GROUPS`. `main.js` extends its class and replaces
  `rows()` with the same code over Herdr's entries plus the mods.
- An entry is `mod.open {name}`; the palette's own `keyOf` finds its key as
  `mod.open:<name>`. Mods Herdr's palette already lists (the picker, as "Go to
  space or tab…") aren't listed twice.
- Each opening compares `base.js` with Herdr's palette and runs `sync.sh` when
  Herdr's changed; the new copy is used from the next opening. `sync.sh`
  refuses a palette without the names `main.js` uses, and the old copy keeps
  working.
- `base.js` is Herdr's code, so it isn't in this repository: run `sync.sh` once
  after copying the folder.

## Watch out

- The palette opens in the middle of the window, not at the top like Herdr's.
- "Recent" starts empty: it is this mod's own list.
- `rows()` is a copy of Herdr's; a later change to how Herdr ranks rows comes
  in only when this file is updated.

## Done when

- `sync.sh` prints nothing and `herdr-app check` passes.
- Ctrl+Shift+P shows "Mods" with each mod's key, and Enter on one opens it.

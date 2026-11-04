# Add files

Puts files into an agent's input the way Ctrl+V puts a copied image there:
pick them, or drop them from a file manager, and each one's path is pasted,
unsent. Claude Code and Codex turn a pasted image path into an attached image
(`[Image #1]`) and read any other file from its path.

## What you see

A window, 480×460, that you can drag anywhere:

- A 32px header: "Add files", "into an agent's input, unsent" in `dim`, "✕".
- "Agent", a band on `raised` (11px semibold), then a row per running agent,
  the focused one first, then the most recently active: an `accent` "●" on the
  chosen one (on `raised`), the program's name, "space / tab · title" in
  `dim`, and its machine in `accent` when it's another one. A click chooses
  it. At most 150px tall, scrolling.
- "Files (N)", the same band, then a row per file: "image", "file", "folder"
  or "gone" (in `blocked`) in a 44px column, its name, its size, "✕". With no
  files, a dashed box: "Drop files here" and "or press Choose… · images
  arrive as [Image #1]".
- A note in `blocked` when something didn't go in.
- A footer: "Choose…", "Clear" when there are files, and "Add to <program>"
  ("Adding…" while it works).

Enter adds, Esc closes.

## How it behaves

- "Choose…" runs `zenity --file-selection --multiple`, starting in the folder
  of the last file added. Dropping files anywhere on the window adds them
  (`on_drop`). One `sh` call tells each path's kind and size.
- "Add to …", for each file:
  - an agent on this computer: its own path, when a terminal wouldn't split it
    (letters, digits and `._-/~+@%,:=`); otherwise `hc put` copies it next to
    the agent's terminal with a plain name and that path is used. A folder's
    path is used with spaces and the like escaped.
  - an agent on another machine: `hc put <machine>/<terminal> <file>` sends it
    there (over Herdr's connection) and prints where it landed; that path is
    used. A folder can't go and is reported.
- Then it saves the clipboard (`wl-paste`: an image first, else text, into a
  `mktemp` file), focuses the agent's pane (`pane.focus`), waits 250 ms, and
  pastes each path with `terminal.paste` (copied with `wl-copy`, `xclip` or
  `pbcopy`), one paste per path so each is seen as a path, with a space
  between them and after the last, 150 ms apart. Nothing presses Enter.
- The saved clipboard is put back with `wl-copy -t <type>`, detached (`setsid -f`)
  and not waited for: wl-copy can keep a waiting caller for seconds.
- Files that went in leave the list. When all did, the window closes (its
  overlay id is read when "Add" is pressed, before anything is awaited);
  otherwise the note names the ones that didn't and why.

## Key

`ctrl-shift-a`: `mod.open:attach` in `global`.

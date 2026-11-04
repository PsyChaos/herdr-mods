#!/bin/sh
# Copies Herdr's own command palette (frame/palette/main.js, rewritten on every
# Herdr start) next to this mod as base.js, exporting what main.js builds on.
# A palette without those names leaves the old copy in place, so Ctrl+Shift+P
# keeps working; that copy is then older than Herdr's.
set -e
app=${1:-$HOME/.config/herdr-app}
dir=$(cd "$(dirname "$0")" && pwd)
src=$app/frame/palette/main.js
[ -f "$src" ] || { echo "no palette at $src" >&2; exit 1; }
for name in "function entries(" "function fuzzy(" "const GROUPS" "export default class Palette"; do
  grep -qF "$name" "$src" || { echo "Herdr's palette changed: no $name" >&2; exit 2; }
done
{ cat "$src"; printf '\n// Added by sync.sh for main.js.\nexport { entries, fuzzy, GROUPS };\n'; } > "$dir/base.js.tmp"
mv "$dir/base.js.tmp" "$dir/base.js"

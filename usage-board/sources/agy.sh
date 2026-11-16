#!/bin/sh
# agy.sh — Antigravity quota, from `agy -p /quota` (prints the quota without a
# model turn: one tab-separated line per window: group, window, % remaining,
# reset). The login is only readable from the desktop session's environment
# (Herdr terminals, this panel), not from a plain ssh shell.
# Output: exactly ONE line of JSON per the panel's data contract.

command -v agy >/dev/null 2>&1 || { echo '{"provider":"agy","skip":true}'; exit 0; }

t=; command -v timeout >/dev/null 2>&1 && t="timeout 9"
dir=$(mktemp -d 2>/dev/null) || dir=
# An empty folder: agy works in its current directory.
out=$(cd "${dir:-/tmp}" && $t agy -p /quota 2>&1); code=$?
[ -n "$dir" ] && rm -rf "$dir"

AGY_OUT=$out python3 - "$code" <<'PYEOF'
import json, os, re, sys
from datetime import datetime, timezone

code = int(sys.argv[1])
text = os.environ.get("AGY_OUT", "")
now = datetime.now(timezone.utc)

def slug(s):
    return "-".join(w for w in re.split(r"[^a-z0-9]+", s.lower()) if w and w not in ("models", "and"))

def iso_z(s):
    try:
        d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
        d = (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
        return d.replace(microsecond=0)
    except ValueError:
        return None

windows = []
for line in text.splitlines():
    f = line.split("\t")
    if len(f) != 4:
        continue
    m = re.fullmatch(r"(\d+(?:\.\d+)?)%", f[2].strip())
    if not m:
        continue
    group, what = f[0].strip(), f[1]
    span = "5h" if "Five Hour" in what else "week" if "Weekly" in what else slug(what)
    short = group[:1].upper() if group.lower().endswith("models") else group.split()[-1][:3]
    reset = iso_z(f[3])
    w = {"id": f"{slug(group)}-{span}",
         "label": f"{short} {'wk' if span == 'week' else span}",
         "used_percent": round(max(0.0, min(100.0, 100 - float(m.group(1)))), 1),
         "resets_at": reset.strftime("%Y-%m-%dT%H:%M:%SZ") if reset else None}
    if reset and reset < now:
        w["stale"] = True
    windows.append(w)

FIRST = ["gemini-5h", "gemini-week", "claude-gpt-5h", "claude-gpt-week"]
windows.sort(key=lambda w: FIRST.index(w["id"]) if w["id"] in FIRST else len(FIRST))  # stable: others keep output order

out = {"provider": "agy", "label": "Antigravity", "plan": None, "windows": windows,
       "updated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),  # agy reports live values
       "source": "agy -p /quota", "ok": True, "error": None}
if code != 0 or not windows:
    first = next((l.strip() for l in text.splitlines() if l.strip()), "")
    if code == 124:
        error = "timed out"
    elif re.search(r"auth|log ?in|sign ?in", text, re.I):
        error = "not logged in"
    elif code == 0:
        error = "agy printed no quota"
    else:
        error = first[:120] or f"agy exited {code}"
    out.update(ok=False, windows=[], error=error)
print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
PYEOF

#!/bin/sh
# Codex usage limits -> one JSON line per CONTRACT.md.
# Reads the newest token_count event carrying rate_limits from the newest
# session JSONL files under ~/.codex/sessions/YYYY/MM/DD/. Read-only.
python3 - <<'PYEOF'
import json, os, sys
from datetime import datetime, timezone

def iso(ts):
    # ts: epoch seconds (int/float) -> ISO-8601 UTC with Z, second precision
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def norm_z(s):
    # "2026-10-19T14:07:19.846Z" -> "2026-10-19T14:07:19Z"
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1]
    if "." in s:
        s = s.split(".", 1)[0]
    return s + "Z"

def fail(msg):
    print(json.dumps({
        "provider": "codex", "label": "Codex", "ok": False,
        "plan": None, "windows": [], "updated_at": None,
        "source": "~/.codex/sessions JSONL rate_limits", "error": msg,
    }))
    sys.exit(0)

root = os.path.expanduser("~/.codex/sessions")
if not os.path.isdir(root):
    fail("~/.codex/sessions not found")

# Candidate files: newest .jsonl by mtime, deepest first.
cands = []
for dirpath, _dirs, files in os.walk(root):
    for f in files:
        if f.endswith(".jsonl"):
            p = os.path.join(dirpath, f)
            try:
                cands.append((os.path.getmtime(p), p))
            except OSError:
                pass
if not cands:
    fail("no .jsonl session files under ~/.codex/sessions")
cands.sort(reverse=True)
cands = cands[:12]

# Newest observation wins: newest files first, last matching line per file.
hit = None
for _mt, path in cands:
    try:
        with open(path, "rb") as fh:
            # Keep the LAST usable record per file: records with limit_id
            # "premium" carry null primary/secondary and must not shadow
            # the older-but-real "codex" window numbers.
            for raw in fh:
                if b"rate_limits" not in raw:
                    continue
                try:
                    line = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                rl = (line.get("payload") or {}).get("rate_limits")
                if not isinstance(rl, dict) or not line.get("timestamp"):
                    continue
                if not isinstance(rl.get("primary") or rl.get("secondary"), dict):
                    continue
                last = line
            if last is None:
                continue
            hit = {"ts": last["timestamp"], "path": path,
                   "rl": (last.get("payload") or {}).get("rate_limits")}
            break
    except (OSError, json.JSONDecodeError):
        continue

if hit is None:
    fail("no rate_limits found in recent session files")

rl = hit["rl"]
primary = rl.get("primary") or {}
secondary = rl.get("secondary") or {}

# window_minutes -> here: 300 = 5h, 10080 = week. Fall back to primary/secondary.
def pick(cands_, mins):
    for c in cands_:
        if isinstance(c, dict) and c.get("window_minutes") == mins:
            return c
    return None

fiveh = pick([primary, secondary], 300) or (primary if isinstance(primary, dict) else {})
week = pick([primary, secondary], 10080) or (secondary if isinstance(secondary, dict) else {})

now = datetime.now(timezone.utc)

def win(id_, label, c):
    if not isinstance(c, dict) or c.get("used_percent") is None or c.get("resets_at") is None:
        return None
    try:
        pct = float(c["used_percent"])
        pct = max(0.0, min(100.0, pct))
        ep = int(c["resets_at"])
        resets = iso(ep)
    except (TypeError, ValueError):
        return None
    w = {"id": id_, "label": label, "used_percent": round(pct, 1), "resets_at": resets}
    if datetime.fromtimestamp(ep, timezone.utc) < now:
        w["stale"] = True  # observation predates the reset: data is old
    return w

windows = [w for w in (win("5h", "5 saat", fiveh), win("week", "Haftalık", week)) if w]

plan = rl.get("plan_type")
out = {
    "provider": "codex",
    "label": "Codex",
    "ok": True,
    "plan": plan if isinstance(plan, str) and plan else None,
    "windows": windows,
    "updated_at": norm_z(hit["ts"]),
    "source": os.path.basename(os.path.dirname(os.path.dirname(hit["path"]))) +
              "/" + os.path.basename(hit["path"]),
    "error": None,
}
print(json.dumps(out))
PYEOF

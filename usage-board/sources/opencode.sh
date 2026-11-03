#!/bin/sh
# OpenCode usage from its own statistics (`opencode stats`), today and the last
# 7 days. OpenCode has no limit window of its own: the models behind it count
# against their providers (shown by those providers' scripts), and its free
# models publish no quota. So this prints totals, not percentages.
#
# Not installed on this machine: prints {"skip": true} and the board leaves it out.
# `--standalone` uses a private server that exits with the command; the default
# starts a background service that stays running.

OC=$(command -v opencode 2>/dev/null)
[ -z "$OC" ] && [ -x "$HOME/.opencode/bin/opencode" ] && OC="$HOME/.opencode/bin/opencode"
if [ -z "$OC" ]; then
  echo '{"provider":"opencode","label":"OpenCode","skip":true}'
  exit 0
fi

TODAY=$(timeout 4 "$OC" stats --standalone --days 0 --models --json 2>/dev/null)
WEEK=$(timeout 4 "$OC" stats --standalone --days 7 --models --json 2>/dev/null)

TODAY="$TODAY" WEEK="$WEEK" python3 - <<'EOF'
import json, os, datetime

def load(name):
    try:
        return json.loads(os.environ.get(name) or "")
    except ValueError:
        return None

def short(n):
    n = float(n)
    for size, unit in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if n >= size:
            v = n / size
            return (f"{v:.0f}" if v >= 100 else f"{v:.1f}".rstrip("0").rstrip(".")) + unit
    return str(int(n))

def tokens(stats):
    t = stats.get("tokens") or {}
    return sum(int(t.get(k) or 0) for k in ("input", "output", "reasoning"))

def line(stats, label):
    cost = float(stats.get("cost") or 0)
    text = f"{short(tokens(stats))} tokens · {stats.get('prompts', 0)} prompts"
    if cost > 0:
        text += f" · ${cost:.2f}"
    return {"id": label.lower(), "label": label, "text": text}

today, week = load("TODAY"), load("WEEK")
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
out = {"provider": "opencode", "label": "OpenCode", "plan": None, "windows": [],
       "updated_at": now, "source": "opencode stats --standalone"}
if not week:
    out.update(ok=False, error="opencode stats gave no data")
else:
    models = sorted(week.get("models") or [], key=lambda m: m.get("steps", 0), reverse=True)
    if models:
        model = (models[0].get("model") or {}).get("id")
        out["plan"] = model.replace("-free", " (free)") if model else None
    out["ok"] = True
    out["totals"] = [line(today or {}, "Today"), line(week, "Week")]
    out["error"] = None
print(json.dumps(out))
EOF
exit 0

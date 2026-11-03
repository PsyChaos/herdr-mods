#!/bin/sh
# claude.sh — usage limits for the Claude Code account of this machine.
# Source: the same data the CLI's /usage command shows, the claude.ai
# /api/oauth/usage endpoint, fetched with the account's own OAuth access
# token from CLAUDE_CONFIG_DIR/.credentials.json (read-only: never printed
# and never refreshed — a refresh would rotate the CLI's refresh token and
# require writing back).
# Output: exactly ONE line of JSON per the panel's data contract.

# Config dir: honor CLAUDE_CONFIG_DIR; otherwise the ~/.claude* folder whose
# login (.credentials.json) changed last, so a custom config dir is found too.
CD="${CLAUDE_CONFIG_DIR:-}"
if [ -z "$CD" ]; then
    CD=$(ls -t "$HOME"/.claude*/.credentials.json 2>/dev/null | head -n 1)
    CD="${CD%/.credentials.json}"
    [ -n "$CD" ] || CD="$HOME/.claude"
fi

python3 - "$CD" <<'PYEOF'
import json, sys, urllib.request, urllib.error
from datetime import datetime, timezone

cd = sys.argv[1]

def out(o):
    print(json.dumps(o, ensure_ascii=False, separators=(",", ":")))
    sys.exit(0)

def iso_z(s):
    # "2026-11-03T13:40:00.385628+00:00" -> "2026-11-03T13:40:00Z"
    try:
        d = datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        d = d.astimezone(timezone.utc).replace(microsecond=0)
        return d.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

empty = {
    "provider": "claude",
    "label": "Claude",
    "plan": None,
    "windows": [
        {"id": "5h", "label": "5 saat", "used_percent": None, "resets_at": None},
        {"id": "week", "label": "Haftalık", "used_percent": None, "resets_at": None},
    ],
    "updated_at": now_iso(),
    "source": "https://claude.ai/api/oauth/usage (Claude Code CLI /usage resource)",
    "ok": False,
    "error": None,
}

def fail(msg):
    e = dict(empty, error=msg)
    out(e)

# --- credentials: access token + plan tier, no secret ever printed ---
try:
    with open(cd + "/.credentials.json", "r", encoding="utf-8") as f:
        cred = json.load(f)
except Exception as ex:
    fail(f"credentials unreadable: {cd}/.credentials.json")

oauth = cred.get("claudeAiOauth") if isinstance(cred, dict) else None
token = oauth.get("accessToken") if isinstance(oauth, dict) else None
expires_ms = oauth.get("expiresAt") if isinstance(oauth, dict) else None
plan = None
if isinstance(oauth, dict):
    plan = oauth.get("subscriptionType") or oauth.get("rateLimitTier")
if not token:
    fail("no OAuth access token in credentials (not signed in?)")

if expires_ms:
    try:
        secs_left = (float(expires_ms) / 1000.0) - datetime.now(timezone.utc).timestamp()
        if secs_left <= 60:
            fail("access token expired (start claude once to refresh); not refreshed here on purpose")
    except Exception:
        pass

# --- fetch: the endpoint /usage shows ---
req = urllib.request.Request(
    "https://claude.ai/api/oauth/usage",
    headers={
        "Authorization": "Bearer " + token,
        "User-Agent": "kullanim-panosu/1.0 (herdr mod)",
        "Accept": "application/json",
    },
)
try:
    with urllib.request.urlopen(req, timeout=8) as r:
        status = r.status
        body = r.read().decode("utf-8", "replace")
        if status == 401:
            fail("unauthorized (401): access token stale; start claude once to refresh")
except urllib.error.HTTPError as ex:
    if ex.code == 401:
        fail("unauthorized (401): access token stale; start claude once to refresh")
    fail(f"usage endpoint HTTP {ex.code}")
except Exception as ex:
    fail(f"usage endpoint unreachable: {type(ex).__name__}")

try:
    data = json.loads(body)
except Exception:
    fail("usage endpoint returned unparseable body")

def window(u):
    if not isinstance(u, dict):
        return None, None, False
    util = u.get("utilization")
    pct = round(float(util), 1) if isinstance(util, (int, float)) else None
    if pct is not None:
        pct = max(0.0, min(100.0, pct))
    return pct, iso_z(u.get("resets_at")) if u.get("resets_at") else None, True

h_pct, h_res, h_ok = window(data.get("five_hour"))
w_pct, w_res, w_ok = window(data.get("seven_day"))

if not h_ok and not w_ok:
    fail("usage response carries no five_hour or seven_day window")

out({
    "provider": "claude",
    "label": "Claude",
    "ok": True,
    "plan": plan,
    "windows": [
        {"id": "5h", "label": "5 saat", "used_percent": h_pct, "resets_at": h_res},
        {"id": "week", "label": "Haftalık", "used_percent": w_pct, "resets_at": w_res},
    ],
    "updated_at": now_iso(),
    "source": "https://claude.ai/api/oauth/usage (Claude Code CLI /usage resource)",
    "error": None,
})
PYEOF

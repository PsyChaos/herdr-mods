# Kullanım panosu — data contract

Each provider has one script in `sources/<provider>.sh`. The panel runs it (on this
machine, or on another Herdr machine with `exec(cmd, args, { on })`) and reads ONE
line of JSON from stdout. The script always exits 0; failures go in `error`.

```json
{
  "provider": "claude",            // claude | codex | ...
  "label": "Claude",               // shown to the person
  "ok": true,                       // false when the data could not be read
  "plan": "max",                    // or null if unknown
  "windows": [
    { "id": "5h",   "label": "5 saat",   "used_percent": 42.0, "resets_at": "2026-11-03T15:41:00Z" },
    { "id": "week", "label": "Haftalık", "used_percent": 18.5, "resets_at": "2026-11-07T09:00:00Z" }
  ],
  "updated_at": "2026-11-03T14:50:00Z", // when the numbers were observed (not when the script ran)
  "source": "short description of where the numbers came from",
  "error": null                     // or a short human-readable reason
}
```

Rules for scripts: POSIX sh (python3 allowed), no new packages, read-only, never
print tokens or secrets, finish within 10 seconds, `used_percent` is 0–100,
`resets_at` is ISO-8601 UTC or null.

Optional per window: `"stale": true` when `resets_at` is already in the past, i.e. the
numbers come from a window that has since reset (the provider wasn't used on this
machine since). The panel shows such a window dimmed with "eski veri" instead of
treating the percentage as current.

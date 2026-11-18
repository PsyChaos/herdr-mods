// Pure parts of Deck's usage tab: readings from reader output, texts, search.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

export const OLD_MS = 30 * 60 * 1000; // a reading older than this shows its age
export const clamp = (p) => Math.max(0, Math.min(100, p));

export function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const hours = Math.floor(minutes / 60);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// "3h ago"; null for a date that doesn't parse.
export function age(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms < 45 * 1000 ? "just now" : `${duration(ms)} ago`;
}

// "16:39" today, "Nov 9" another day, "passed" once past.
export function resetShort(iso, now = Date.now()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.getTime() <= now) return "passed";
  return d.toDateString() === new Date(now).toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export const percentText = (p) => `${Number.isInteger(p) ? p : Math.round(p * 10) / 10}%`;

// The reader prints one line; keep the last non-empty one.
export const lastLine = (text) => (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

// One reader result ({stdout, code} or {failed}) -> an entry, or {skip: true}. Every failure becomes a readable error.
export function parseResult(machine, provider, result) {
  const bad = (error) => ({ machine, provider, label: provider, windows: [], totals: [], error });
  if (result.failed) return bad(result.failed?.message ?? String(result.failed));
  const line = lastLine(result.stdout);
  if (!line) return bad(result.code === 0 ? "Script printed nothing" : `Script failed (exit ${result.code})`);
  let data;
  try { data = JSON.parse(line); } catch { return bad("Output isn't valid JSON"); }
  if (!data || typeof data !== "object") return bad("Output isn't a JSON object");
  if (data.skip === true) return { machine, provider, skip: true }; // not installed there: no row
  return {
    machine,
    provider: String(data.provider ?? provider),
    label: data.label ?? data.provider ?? provider,
    plan: data.plan ?? null,
    windows: (Array.isArray(data.windows) ? data.windows : [])
      .filter((w) => w && typeof w === "object" && Number.isFinite(Number(w.used_percent)))
      .map((w) => ({ ...w, used_percent: clamp(Number(w.used_percent)), stale: w.stale === true })),
    totals: (Array.isArray(data.totals) ? data.totals : [])
      .filter((x) => x && typeof x === "object" && x.text != null)
      .map((x) => ({ id: String(x.id ?? x.label ?? ""), label: String(x.label ?? x.id ?? ""), text: String(x.text) })),
    updated_at: data.updated_at ?? null,
    error: data.error ?? (data.ok === false ? "Couldn't read usage" : null),
  };
}

// The note at a provider's right: "stale", the age of an old reading, or nothing.
export function noteOf(e, now = Date.now()) {
  if (e.windows.length && e.windows.every((w) => w.stale)) return "stale";
  return e.updated_at && now - new Date(e.updated_at).getTime() > OLD_MS ? age(e.updated_at, now) : null;
}

// Search: every word must be in machine, provider, label, plan or error.
export function matches(e, query) {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [e.machine ?? "here this computer", e.provider, e.label, e.plan, e.error].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

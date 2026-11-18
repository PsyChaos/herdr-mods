// Deck's shared probe: one `sh` script per machine every 5 s, parsed into
// samples that live in module-scope ring buffers (see docs/designs/deck-look.md).
// The pure part (PROBE, parse, step, tree, record) imports nothing from Herdr
// so node can test it; `probeAll` is the only code that calls exec.

export const MAX = 120; // samples per series
export const AGENT_MAX = 30;
export const IDS_MAX = 30;

// Prints labelled sections. Ids come as "$@" and are only quoted, never eval'd.
export const PROBE = String.raw`
echo "@up"; cut -d' ' -f1 /proc/uptime
echo "@stat"; grep '^cpu' /proc/stat
echo "@mem"; awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/{print $1, $2}' /proc/meminfo
echo "@disk"; df -kP / | tail -n 1 | awk '{print $2, $3, $4}'
echo "@net"; grep -v '^ *lo:' /proc/net/dev | tail -n +3
echo "@hz"; getconf CLK_TCK
echo "@pagesize"; getconf PAGESIZE
echo "@proc"
cat /proc/[0-9]*/stat 2>/dev/null | awk '{ pid=$1; s=$0; sub(/^.*\) /, "", s); split(s, a, " "); print pid, a[2], a[12]+a[13], a[22] }'
HC=$(command -v hc || echo "$HOME/.local/bin/hc")
for id in "$@"; do
  j=$("$HC" get "$id" --json 2>/dev/null) || continue
  echo "@term $id"; echo "$j"
  cwd=$(printf %s "$j" | sed -n 's/.*"foreground":{[^}]*"cwd":"\([^"]*\)".*/\1/p')
  [ -n "$cwd" ] || cwd=$(printf %s "$j" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p' | head -n 1)
  echo "@git $id"
  [ -n "$cwd" ] && git -C "$cwd" rev-parse --abbrev-ref HEAD --path-format=absolute --git-common-dir 2>/dev/null
done
`;

const nums = (line) => line.trim().split(/\s+/).map(Number);

// Text of PROBE -> raw numbers and objects. Unknown or short sections give null/empty.
export function parse(text) {
  const sec = {};
  let key = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("@")) { key = line.slice(1).trim(); sec[key] = []; } else if (key && line.trim()) sec[key].push(line);
  }
  const first = (k) => Number(sec[k]?.[0]);
  const cpu = {};
  for (const l of sec.stat ?? []) {
    const [name, ...f] = l.trim().split(/\s+/);
    const v = f.map(Number);
    cpu[name] = { busy: v[0] + v[1] + v[2] + (v[5] ?? 0) + (v[6] ?? 0) + (v[7] ?? 0), total: v.slice(0, 8).reduce((a, b) => a + b, 0) };
  }
  const mem = {};
  for (const l of sec.mem ?? []) { const [k, v] = l.split(/\s+/); mem[k.replace(":", "")] = Number(v); }
  const [size, used, avail] = nums(sec.disk?.[0] ?? "");
  let rx = 0, tx = 0;
  for (const l of sec.net ?? []) {
    const f = l.slice(l.indexOf(":") + 1).trim().split(/\s+/).map(Number);
    rx += f[0] || 0; tx += f[8] || 0;
  }
  const procs = (sec.proc ?? []).map((l) => { const [pid, ppid, ticks, rss] = nums(l); return { pid, ppid, ticks, rss }; });
  const terms = {};
  for (const k of Object.keys(sec)) {
    if (!k.startsWith("term ")) continue;
    const id = k.slice(5);
    let hc = null;
    try { hc = JSON.parse(sec[k].join("\n")); } catch { /* skipped terminal */ }
    const [branch, common] = sec[`git ${id}`] ?? [];
    const repo = common ? common.replace(/\/\.git\/?$/, "").split("/").pop() : null;
    terms[id] = { pid: hc?.pid ?? null, created_ms: hc?.created_ms ?? null, repo: repo || null, branch: common ? branch : null };
  }
  return {
    up: first("up"), cpu, mem: { total: mem.MemTotal, avail: mem.MemAvailable, swapTotal: mem.SwapTotal, swapFree: mem.SwapFree },
    disk: { size, used, avail }, net: { rx, tx }, hz: first("hz") || 100, pageSize: first("pagesize") || 4096, procs, terms,
  };
}

const pct = (a, b) => (b.total > a.total ? Math.round(((b.busy - a.busy) / (b.total - a.total)) * 1000) / 10 : null);

// Process and all its descendants: CPU ticks, rss (pages) and the pids visited.
export function tree(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const by = new Map(procs.map((p) => [p.pid, p]));
  let ticks = 0, rss = 0, any = false;
  const pids = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = by.get(pid);
    if (p) { any = true; ticks += p.ticks; rss += p.rss; pids.push(pid); }
    stack.push(...(kids.get(pid) ?? []).map((k) => k.pid));
  }
  return any ? { ticks, rss, pids } : null;
}

// Two raws -> a sample. Without prev the rates are null. Process CPU is kept
// per terminal id as ticks plus the tree's rss so the next step has its baseline.
export function step(prev, raw) {
  const dt = prev ? raw.up - prev.up : 0;
  const ok = prev && dt > 0;
  const mem = raw.mem;
  const used = mem.total - mem.avail;
  const agents = {};
  const nowTicks = new Map(raw.procs.map((p) => [p.pid, p.ticks]));
  const prevTicks = ok ? new Map(prev.procs.map((p) => [p.pid, p.ticks])) : null;
  for (const [id, term] of Object.entries(raw.terms)) {
    const now = term.pid == null ? null : tree(raw.procs, term.pid);
    // Per process, so a child that exited since the last sample doesn't cancel the others' ticks.
    const known = ok && now && prev.terms[id]?.pid === term.pid;
    const ticks = known ? now.pids.reduce((sum, pid) => sum + Math.max(0, nowTicks.get(pid) - (prevTicks.get(pid) ?? 0)), 0) : null;
    agents[id] = {
      cpu: known ? Math.round((ticks / raw.hz / dt) * 1000) / 10 : null,
      rssKiB: now ? Math.round((now.rss * raw.pageSize) / 1024) : null,
      created_ms: term.created_ms, repo: term.repo, branch: term.branch,
    };
  }
  const cores = Object.keys(raw.cpu).filter((k) => k !== "cpu").sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  return {
    up: raw.up,
    cpu: ok && prev.cpu.cpu ? pct(prev.cpu.cpu, raw.cpu.cpu) : null,
    cores: cores.map((c) => (ok && prev.cpu[c] ? pct(prev.cpu[c], raw.cpu[c]) : null)),
    mem: {
      pct: mem.total ? Math.round((used / mem.total) * 1000) / 10 : 0, usedKiB: used, totalKiB: mem.total,
      swapPct: mem.swapTotal ? Math.round(((mem.swapTotal - mem.swapFree) / mem.swapTotal) * 1000) / 10 : 0,
    },
    disk: { pct: raw.disk.size ? Math.round((raw.disk.used / raw.disk.size) * 1000) / 10 : 0, freeKiB: raw.disk.avail, totalKiB: raw.disk.size },
    net: ok ? { rxBps: Math.max(0, (raw.net.rx - prev.net.rx) / dt), txBps: Math.max(0, (raw.net.tx - prev.net.tx) / dt) } : null,
    agents,
  };
}

const push = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max); };

// store: {[machine]: MachineProbe plus a private `raw`}. result: {raw, addresses} or {error}.
// A failed probe keeps the last sample, sets ok false and appends null.
export function record(store, machine, result) {
  const m = store[machine] ??= { ok: false, error: null, sample: null, history: { cpu: [], mem: [], rx: [], tx: [] }, agents: {}, raw: null };
  const s = result.raw ? step(m.raw, result.raw) : null;
  m.ok = Boolean(s);
  m.error = s ? null : result.error ?? "probe failed";
  if (s) { m.sample = { ...s, agents: undefined }; m.raw = result.raw; }
  m.at = Date.now(); // when the series last moved, for the gap after a close
  const h = m.history;
  push(h.cpu, s ? s.cpu : null, MAX);
  push(h.mem, s ? s.mem.pct : null, MAX);
  push(h.rx, s?.net ? s.net.rxBps : null, MAX);
  push(h.tx, s?.net ? s.net.txBps : null, MAX);
  const addr = result.addresses ?? {}; // bare terminal id -> address, as agents() has it
  for (const a of Object.keys(m.agents)) if (!Object.values(addr).includes(a)) delete m.agents[a];
  const seen = new Set();
  for (const [id, a] of Object.entries(s?.agents ?? {})) {
    const cur = m.agents[addr[id] ?? id] ??= { history: [] };
    seen.add(cur);
    Object.assign(cur, a);
    push(cur.history, a.cpu, AGENT_MAX);
  }
  // Missing from a good sample (hc get failed): no stale numbers. Failed probe: keep the last ones.
  for (const cur of Object.values(m.agents)) {
    if (seen.has(cur)) continue;
    if (s) { cur.cpu = null; cur.rssKiB = null; }
    push(cur.history, null, AGENT_MAX);
  }
  return m;
}

// ---- Herdr side (not imported by the test) ----

// Runs the probe on every machine and fills ctx.probe-shaped `store`.
// machines: [{name|null, addresses: {bare id: address}, skip}]
export async function probeAll(exec, store, machines) {
  await Promise.all(machines.map(async ({ name, addresses = {}, skip }) => {
    const ids = Object.keys(addresses).slice(0, IDS_MAX);
    const key = name ?? "here";
    if (skip) return void record(store, key, { error: "unavailable", addresses });
    try {
      const r = await exec("sh", ["-c", PROBE, "probe", ...ids], { ...(name ? { on: name } : {}), timeout: 3000 });
      if (r.code !== 0 && !r.stdout) throw new Error(r.stderr?.trim() || `exit ${r.code}`);
      record(store, key, { raw: parse(r.stdout), addresses });
    } catch (e) {
      record(store, key, { error: String(e?.message ?? e), addresses });
    }
  }));
}

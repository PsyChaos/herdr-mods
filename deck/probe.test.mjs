import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse, step, tree, record, MAX } from "./probe.js";

const text = await readFile(new URL("./fixture/probe-here.txt", import.meta.url), "utf8");
const a = parse(text);
assert.ok(a.up > 0 && a.hz > 0 && a.mem.total > 0 && a.disk.size > 0);
assert.ok(a.procs.length > 10 && a.cpu.cpu && Object.keys(a.cpu).length > 1);
assert.ok(a.terms.t10q.pid > 0 && a.terms.t10q.created_ms > 0 && a.terms.t10q.repo === "demo");

// step: no baseline -> nulls; with one -> numbers
const s0 = step(null, a);
assert.equal(s0.cpu, null);
assert.equal(s0.net, null);
assert.ok(s0.mem.pct > 0 && s0.disk.pct > 0 && s0.agents.t10q.rssKiB > 0 && s0.agents.t10q.cpu === null);
const b = structuredClone(a);
b.up += 5;
b.cpu.cpu.total += 1000; b.cpu.cpu.busy += 250;
b.net.rx += 5000;
const me = b.procs.find((p) => p.pid === a.terms.t10q.pid);
me.ticks += b.hz * 5 / 2; // half a core
const s1 = step(a, b);
assert.equal(s1.cpu, 25);
assert.equal(s1.net.rxBps, 1000);
assert.equal(s1.agents.t10q.cpu, 50);
assert.ok(s1.cores.length === s0.cores.length);

// a child that exited since the last sample must not zero the agent's CPU
const pid0 = a.terms.t10q.pid;
const c = structuredClone(a);
c.procs.push({ pid: 999999, ppid: pid0, ticks: 6000, rss: 1 });
const d = structuredClone(a);
d.up += 5;
d.procs.find((p) => p.pid === pid0).ticks += d.hz * 5 / 2;
assert.equal(step(c, d).agents.t10q.cpu, 50);

// tree: a process and its descendants
const procs = [{ pid: 1, ppid: 0, ticks: 1, rss: 1 }, { pid: 2, ppid: 1, ticks: 2, rss: 2 }, { pid: 3, ppid: 2, ticks: 4, rss: 4 }, { pid: 9, ppid: 0, ticks: 8, rss: 8 }];
assert.deepEqual(tree(procs, 2), { ticks: 6, rss: 6, pids: [2, 3] });
assert.equal(tree(procs, 77), null);

// record: ring buffer, a gap on failure, gone agents dropped
const store = {};
record(store, "here", { raw: a, addresses: { t10q: "t10q" } });
record(store, "here", { raw: b, addresses: { t10q: "t10q" } });
assert.equal(store.here.ok, true);
assert.equal(store.here.history.cpu.at(-1), 25);
assert.ok(store.here.agents.t10q.history.length === 2);
record(store, "here", { error: "boom", addresses: {} });
assert.equal(store.here.ok, false);
assert.equal(store.here.error, "boom");
assert.equal(store.here.history.cpu.at(-1), null);
assert.ok(store.here.sample);
assert.deepEqual(Object.keys(store.here.agents), []);
// an agent missing from a good sample loses its numbers and gets a gap
record(store, "here", { raw: a, addresses: { t10q: "t10q" } });
record(store, "here", { raw: b, addresses: { t10q: "t10q" } });
const gone = { ...b, terms: {} };
record(store, "here", { raw: gone, addresses: { t10q: "t10q" } });
assert.equal(store.here.agents.t10q.cpu, null);
assert.equal(store.here.agents.t10q.history.at(-1), null);
for (let i = 0; i < MAX + 10; i++) record(store, "here", { error: "x" });
assert.equal(store.here.history.cpu.length, MAX);
console.log("probe ok");

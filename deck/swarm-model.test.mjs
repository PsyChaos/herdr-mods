import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { model, mergeBoards, addressOn, shortModel, providerKey, EFFORT, duration, STAGES, liveMap, fixtureLive } from "./swarm-model.js";

const now = Date.parse("2026-11-18T12:00:00Z");
const task = { id: "T1", title: "Build", terminal: "t1", provider: "codex", model: "gpt-6.1-sol", effort: "medium",
  stage: "cook", started: "2026-11-18T11:45:00Z" };
const run = { id: "run", status: "open", created: "2026-11-18T11:00:00Z", chef: "t0", tasks: [task] };
const helpers = [{ terminal: "t2", role: "resolve", name: "thor" }, { terminal: "t3", role: "review", name: "storm" }];
const entriesMap = (entries) => new Map(Object.entries(entries));
const row = (changes = {}, entries = {}, machine = null) => model([{ ...run, machine, tasks: [{ ...task, ...changes }] }], entriesMap(entries), now).open[0].rows[0];

// State precedence is independent of stale task.status; only live terminals count.
for (const [changes, entries, state, color] of [
  [{ stage: "dropped", helpers }, { t1: { status: "blocked" }, t2: { status: "working" } }, "dropped", "dim"],
  [{ stage: "pass" }, { t1: { status: "blocked" } }, "plated", "done"],
  [{ stage: "pass", helpers }, { t1: { status: "blocked" }, t2: { status: "blocked" } }, "needs you", "blocked"],
  [{ stage: "sent_back", helpers }, { t2: { status: "blocked" } }, "needs you", "blocked"],
  [{ stage: "sent_back", helpers }, { t1: { status: "working" }, t3: { status: "working" } }, "sent back", "ansi1"],
  [{ helpers }, { t1: { status: "working" }, t2: { status: "working" }, t3: { status: "working" } }, "review", "working"],
  [{ helpers }, { t1: { status: "working" }, t2: { status: "working" } }, "fixing", "working"],
  [{ stage: "pass" }, { t1: { status: "working" } }, "cooking", "working"],
  [{ stage: "pass" }, {}, "plated", "done"],
  [{ stage: "taste" }, {}, "checked", "muted"],
  [{ stage: "review" }, {}, "checked", "muted"],
  [{ stage: "fire", status: "working" }, {}, "waiting", "dim"],
  [{ stage: undefined }, {}, "waiting", "dim"],
]) {
  assert.deepEqual([row(changes, entries).state, row(changes, entries).color], [state, color]);
}

const busy = { t1: { status: "working", msg: "Worker message" }, t2: { status: "working", name: "live thor", msg: "Fixing" },
  t3: { status: "blocked", msg: "Question" } };
assert.deepEqual(row({ helpers }, busy).doing, { who: "thor", msg: "Fixing" });
assert.deepEqual(row({ helpers: [...helpers].reverse() }, busy).doing, { who: "storm", msg: "Question" });
assert.deepEqual(row({ helpers: [{ ...helpers[0], name: null }] }, busy).doing, { who: "live thor", msg: "Fixing" });
assert.deepEqual(row({ helpers: [{ terminal: "t3", role: "review" }] }, busy).doing, { who: "review", msg: "Question" });
assert.deepEqual(row({ helpers }, { ...busy, t2: { status: "done", msg: "Old" }, t3: { status: "idle", msg: "Old" } }).doing,
  { who: null, msg: "Worker message" });
assert.deepEqual(row({ helpers }, { ...busy, t2: { status: "working", msg: "" }, t3: { status: "blocked" } }).doing,
  { who: null, msg: "Worker message" });
for (const entry of [{}, { msg: "" }, { msg: "  " }, { msg: 3 }, { report: "Running" }, { report: { msg: "Unnormalized" } }]) {
  assert.equal(row({}, { t1: entry }).doing, null);
}
assert.equal(row().doing, null);
assert.equal(row({ name: "board" }, { t1: { name: "live" } }).worker.name, "board");
assert.equal(row({}, { t1: { name: "live" } }).worker.name, "live");
assert.deepEqual(row().worker, { name: null, provider: "codex", model: "gpt-6.1-sol", effort: "medium" });

// Every target precedence transition, including inactive helpers and absent workers.
for (const [entries, target] of [
  [{ t1: { status: "blocked" }, t2: { status: "blocked" } }, "t1"],
  [{ t1: { status: "working" }, t2: { status: "blocked" } }, "t2"],
  [{ t1: { status: "working" }, t2: { status: "working" } }, "t1"],
  [{ t1: { status: "idle" }, t2: { status: "working" } }, "t2"],
  [{ t1: { status: "done" }, t2: { status: "done" } }, "t1"],
  [{ t2: { status: "done" } }, null],
  [{}, null],
]) assert.deepEqual(row({ helpers }, entries).target, target ? { terminal: target, machine: null } : null);
assert.deepEqual(row({ helpers }, { "hub/t2": { status: "working", msg: "Remote" } }, "hub").target,
  { terminal: "hub/t2", machine: "hub" });
assert.equal(row({}, {}, "hub").key, "hub:run:T1");
assert.equal(row().key, ".:run:T1");
assert.equal(row({ stage: "pass", name: "new name" }).key, row().key);

const findings = [{ severity: "high", file: "main.js", line: 12, issue: "Race" }];
const problems = ["First", "Second", "Third", "Fourth"];
assert.deepEqual(row({ stage: "sent_back", review: { items: findings }, check: { problems } }).findings, findings);
assert.deepEqual(row({ stage: "sent_back", review: { items: [] }, check: { problems } }).findings, []);
assert.deepEqual(row({ stage: "sent_back", check: { problems } }).findings,
  problems.slice(0, 3).map((issue) => ({ severity: "check", issue })));
assert.equal(row({ stage: "sent_back", review: { items: [...findings, ...findings, ...findings, ...findings] } }).findings.length, 3);
assert.deepEqual(row({ stage: "sent_back" }).findings, []);
assert.deepEqual(row({ stage: "review", review: { items: findings }, check: { problems } }).findings, []);
assert.deepEqual(row({ stage: "sent_back", review: { items: findings } }, { t1: { status: "blocked" } }).findings, findings);
assert.equal(row().elapsed, "15m");
assert.equal(row({ finished: "2026-11-18T11:48:00Z" }).elapsed, "3m");
assert.equal(row({ started: "2026-11-18T09:30:00Z" }).elapsed, "2h");
assert.equal(row({ started: null }).elapsed, "");
assert.equal(row({ started: "invalid" }).elapsed, "");
assert.equal(row({ started: "2026-11-18T13:00:00Z" }).elapsed, "");
assert.equal(duration(59000), "0m");

const orderTasks = [
  { id: "T9", stage: "dropped" }, { id: "T8", stage: "pass" }, { id: "T7", stage: "fire" },
  { id: "T6", stage: "taste" }, { id: "T5", terminal: "t5" },
  { id: "T4", helpers: [{ terminal: "t4", role: "resolve" }] },
  { id: "T3", helpers: [{ terminal: "t3", role: "review" }] },
  { id: "T2", stage: "sent_back" }, { id: "T1", terminal: "t1" }, { id: "T0", terminal: "t1" },
];
const ordered = model([{ ...run, tasks: orderTasks }], entriesMap({ t1: { status: "blocked" },
  t3: { status: "working" }, t4: { status: "working" }, t5: { status: "working" } }), now);
assert.deepEqual(ordered.open[0].rows.map((r) => r.id), Array.from({ length: 10 }, (_, i) => `T${i}`));
assert.deepEqual(model([{ ...run, tasks: ["T10", "T2", "T1"].map((id) => ({ id, stage: "fire" })) }], new Map(), now)
  .open[0].rows.map((r) => r.id), ["T1", "T2", "T10"]);
assert.deepEqual(model([], new Map(), now), { open: [], served: [] });
const legacy = { version: 1, runs: [{ id: "old", status: "open", tasks: [
  { id: "T1", stage: "sent_back", terminal: "t1", provider: "claude", review: { verdict: "changes" } },
] }] };
const legacyBefore = JSON.stringify(legacy);
const oldRow = model(mergeBoards(new Map([["", legacy]])).runs, new Map(), now).open[0].rows[0];
assert.equal(oldRow.worker.name, null);
assert.deepEqual(oldRow.findings, []);
assert.equal(oldRow.doing, null);
assert.equal(JSON.stringify(legacy), legacyBefore);
const chefRun = model([{ ...run, machine: "hub" }], entriesMap({ "hub/t0": { name: "chef", msg: "Waiting" } }), now).open[0];
assert.deepEqual(chefRun.chef, { address: "hub/t0", name: "chef", msg: "Waiting", target: { terminal: "hub/t0", machine: "hub" } });
assert.equal(model([run], new Map(), now).open[0].chef.name, "t0");
assert.equal(model([{ ...run, chef: null }], new Map(), now).open[0].chef, null);

const boards = new Map([
  ["", { host: "same", runs: [run, { ...run, id: "older", created: "2026-11-18T10:00:00Z" }],
    stats: [{ provider: "agy", plates: 1 }] }],
  ["hub", { host: "same", runs: [run, run], stats: [{ provider: "gemini", plates: 2 }] }],
]);
const merged = mergeBoards(boards);
assert.equal(merged.runs.length, 3);
assert.equal(merged.stats.find((s) => s.provider === "antigravity").plates, 3);
assert.deepEqual(model(merged.runs, new Map(), now).open.map(({ run }) => run.id), ["run", "run", "older"]);
assert.equal(new Set(model(merged.runs, new Map(), now).open.flatMap((o) => o.rows.map((r) => r.key))).size, 3);

const closed = Array.from({ length: 7 }, (_, i) => ({ ...run, id: `closed${i}`, machine: i % 2 ? "hub" : null,
  status: "closed", created: `2026-11-18T0${i}:00:00Z`, pr: `https://example.com/pull/${i}`,
  tasks: [{ finished: `2026-11-18T0${i}:10:00Z` }, { finished: `2026-11-18T0${i}:25:00Z` }] }));
const served = model(closed.reverse(), new Map(), now).served;
assert.deepEqual(served.map((r) => r.run.id), ["closed6", "closed5", "closed4", "closed3", "closed2"]);
assert.equal(served[0].count, 2);
assert.equal(served[0].duration, "25m");
assert.deepEqual(served[0].target, { url: "https://example.com/pull/6" });
assert.equal(served[0].key, ".:closed6:served");
const unknown = model([{ ...closed[0], created: null, pr: null }, { ...closed[1], tasks: [] }], new Map(), now).served;
assert(unknown.every((r) => r.duration === ""));
assert.equal(unknown.find((r) => !r.pr).target, null);

assert.equal(addressOn("hub", "t1"), "hub/t1");
assert.equal(addressOn("hub", "other/t1"), "other/t1");
assert.equal(addressOn(null, "t1"), "t1");
assert.equal(addressOn("hub", null), null);
assert.deepEqual(["AGY", "antigravity-pro", "gemini", "Codex"].map(providerKey), ["antigravity", "antigravity", "antigravity", "codex"]);
assert.deepEqual(["gpt-6.1-sol", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku", "fable", null].map(shortModel),
  ["sol", "opus", "son", "hai", "fab", "?"]);
assert.equal(EFFORT.medium, "med");
assert.deepEqual(STAGES, ["fire", "cook", "taste", "review", "pass"]);

const terminals = [
  { address: "t1", state: "live", status: "idle", name: "thor", report: { msg: "Testing" } },
  { address: "t2", state: "live", status: "working", report: "Testing" },
  { address: "t3", state: "live", status: "blocked" },
  { address: "t4", state: "live", report: { msg: 42 } },
  { address: "t5", state: "live", report: null },
  { address: "t6", state: "live", report: { msg: "" } },
  { address: "hub/t7", state: "live", status: "idle", name: "remote", report: { msg: "Remote work" } },
  { address: "t8", state: "gone", status: "working", report: { msg: "Stale" } },
  { address: "t9", status: "working" },
];
const agents = [{ address: "t1", status: "working" }, { address: "t2", status: null },
  { address: "hub/t7", status: "blocked" }, { address: "t8", status: "blocked" }, { address: "missing", status: "working" }];
const snapshotsBefore = JSON.stringify({ terminals, agents });
const normalized = liveMap(terminals, agents);
assert.deepEqual(normalized.get("t1"), { status: "working", name: "thor", msg: "Testing" });
assert.deepEqual(normalized.get("t2"), { status: "working", name: null, msg: null });
assert.deepEqual(normalized.get("t3"), { status: "blocked", name: null, msg: null });
assert.deepEqual(normalized.get("t4"), { status: "idle", name: null, msg: null });
assert.equal(normalized.get("t5").msg, null);
assert.equal(normalized.get("t6").msg, "");
assert.deepEqual(normalized.get("hub/t7"), { status: "blocked", name: "remote", msg: "Remote work" });
assert.equal(normalized.size, 7);
assert.equal(normalized.has("t8"), false);
assert.equal(normalized.has("t9"), false);
assert.equal(normalized.has("missing"), false);
assert.equal(JSON.stringify({ terminals, agents }), snapshotsBefore);
assert.deepEqual(model([run], normalized, now).open[0].rows[0].doing, { who: null, msg: "Testing" });
assert.equal(model([{ ...run, tasks: [{ ...task, terminal: "t2" }] }], normalized, now).open[0].rows[0].doing, null);
assert.deepEqual(liveMap([], []), new Map());

const fixture = JSON.parse(await readFile(new URL("./fixture/board.json", import.meta.url), "utf8"));
const fixtureBoards = new Map([["", fixture]]);
const fixtureModel = model(mergeBoards(fixtureBoards).runs, fixtureLive(fixtureBoards), now);
assert.equal(fixtureModel.open.length, 2);
assert.equal(fixtureModel.served.length, 1);
assert.equal(new Set(fixtureModel.open.flatMap((o) => o.rows.map((r) => r.state))).size, 9);
assert(fixtureModel.open.flatMap((o) => o.rows).some((r) => r.findings.length));
assert(fixtureModel.served[0].pr);
const fixtureBefore = JSON.stringify(fixture);
const remoteFixture = fixtureLive(new Map([["hub", fixture], ["unavailable", null]]));
assert.deepEqual(remoteFixture.get("hub/t1"), { status: "working" });
assert.deepEqual(remoteFixture.get("hub/t60"), { status: "working", msg: "Inspecting the change" });
assert.equal(remoteFixture.has("t1"), false);
assert.equal(JSON.stringify(fixture), fixtureBefore);
assert.deepEqual(fixtureLive(new Map()), new Map());
console.log("Swarm model: all assertions passed (states, activity, targets, findings, ordering, served, legacy board, fixture).");

import assert from "node:assert/strict";
import { stateOf, rollup, parseLog, logError, message, hit, build, finishes, busy, prDetail, ownerOf, runIdOf } from "./prs-model.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ck = (name, status, conclusion, url = `https://x/actions/runs/${name.length}`) => ({ name, status, conclusion, url });
const pr = (number, branch, checks, extra = {}) => ({ number, title: `T${number}`, url: `https://x/pull/${number}`, branch, draft: false,
  author: "ann", bot: false, updated: "2026-01-01T10:00:00Z", review: null, checks, ...extra });
const repo = (name, prs, runs = [], extra = {}) => ({ repo: name, folder: `~/${name}`, branch: "main", sources: [`~/${name}`], prs, runs, ...extra });

assert.deepEqual(["success", "failure", "cancelled", "neutral"].map((c) => stateOf("completed", c)), ["pass", "fail", "cancelled", "skip"]);
assert.equal(stateOf("in_progress", null), "running");
assert.deepEqual([[], [ck("a", "completed", "success")], [ck("a", "completed", "success"), ck("b", "queued", null)], [ck("a", "in_progress", null), ck("b", "completed", "failure")]].map(rollup), ["none", "pass", "running", "fail"]);
assert.equal(runIdOf("https://x/actions/runs/123/job/4"), "123");

const lines = parseLog("build\ttest\t2026-11-04T10:00:00.1Z \x1b[31mboom\x1b[0m\nplain");
assert.deepEqual(lines, [{ job: "build", step: "test", text: "boom" }, { job: null, step: null, text: "plain" }]);
assert.match(logError(1, "", "HTTP 410: gone", 0), /expired/);
assert.match(logError(0, "", "", 0), /No failed step/);
assert.match(message({ lines, what: "#1 e2e", repo: "o/r", url: "u" }), /Failed step: build \/ test[\s\S]*boom[\s\S]*Find the cause/);

assert.ok(hit("lint ann", "o/r", "#1 fix ann failed lint"));
assert.ok(!hit("lint bob", "o/r", "#1 fix ann failed lint"));
assert.ok(hit("  ", "o/r", ""));

const bad = pr(1, "f1", [ck("lint", "completed", "failure")]);
assert.match(prDetail(bad, NOW).text, /f1 · ann · failed: lint · 2h ago/);
const bot = (n, c) => pr(n, `dep${n}`, [ck("ci", "completed", c)], { bot: true, author: "dependabot" });
const results = { here: { machine: null, repos: [repo("o/a", [bad, pr(2, "f2", [ck("ci", "in_progress", null)]), bot(3, "failure"), bot(4, "success")],
  [{ id: 9, workflow: "CI", status: "completed", conclusion: "success", url: "u9", title: "t", updated: "" }]),
  repo("o/quiet", []), repo("o/b", [], [{ id: 8, workflow: "CI", status: "completed", conclusion: "failure", url: "u8", title: "t", updated: "" }])] } };
const owners = new Map([["null|~/o/a", { space: "s1", rank: 0 }], ["null|~/o/b", { space: "s1", rank: 1 }], ["null|~/o/quiet", { space: "s1", rank: 0 }]]);
const spaces = [{ id: "s1", name: "dev" }, { id: "s2", name: "empty" }];
assert.equal(ownerOf(owners, null, { sources: ["~/o/b", "~/o/a"] }), "s1");

let m = build({ results, spaces, owners, now: NOW });
assert.deepEqual(m.totals, { prs: 4, fail: 2, running: 1, found: 4, quiet: 1 });
assert.deepEqual(m.panels.map((p) => p.space.name), ["dev"]); // empty space has no panel
assert.deepEqual(m.panels[0].repos[0].items.map((i) => i.kind), ["run", "pr", "pr", "bots"]);
assert.deepEqual(m.panels[0].repos[1].items.map((i) => i.kind), ["run"]); // o/b: a run alone, o/quiet dropped
const botsRow = m.panels[0].repos[0].items.find((i) => i.kind === "bots");
assert.deepEqual([botsRow.count, botsRow.failing, botsRow.names], [2, 1, "dependabot"]);
assert.equal(m.rows.find((r) => r.key === botsRow.key).target, null);
assert.deepEqual(m.rows[1].target, { url: "https://x/pull/1" });

m = build({ results, spaces, owners, botsOpen: new Set(["null|o/a"]), now: NOW });
assert.equal(m.panels[0].repos[0].items.length, 6); // bots unfolded
m = build({ results, spaces, owners, query: "dependabot", now: NOW }); // matching bots show unfolded, no bots line
assert.deepEqual(m.panels[0].repos[0].items.map((i) => i.kind), ["pr", "pr"]);
assert.equal(m.totals.found, 2);
m = build({ results, spaces, owners, query: "dev lint", now: NOW });
assert.deepEqual(m.rows.map((r) => r.key), ["pr|null|o/a|1"]);
assert.equal(build({ results, spaces, owners, query: "nope", now: NOW }).panels.length, 0);

// finishes: first answer primes; a running PR that passes, and a new run id, each notify once.
const seen = new Map();
const r1 = [repo("o/a", [pr(2, "f2", [ck("ci", "in_progress", null)])], [])];
assert.deepEqual(finishes(seen, false, "m", r1), []);
const r2 = [repo("o/a", [pr(2, "f2", [ck("ci", "completed", "success")])], [])];
assert.deepEqual(finishes(seen, true, "m", r2).map((f) => [f.state, f.title]), [["pass", "o/a #2"]]);
assert.deepEqual(finishes(seen, true, "m", r2), []);
const runRepo = (id, c) => [repo("o/b", [], [{ id, workflow: "CI", status: "completed", conclusion: c, title: "t" }])];
finishes(seen, true, "m", runRepo(1, "success"));
assert.deepEqual(finishes(seen, true, "m", runRepo(2, "failure")).map((f) => f.state), ["fail"]);
assert.ok(busy(results) && !busy({ a: { repos: runRepo(1, "success") } }));
assert.equal(prDetail(bad, NOW).runId, "4"); // from the failed check url
console.log("ok prs-model");

import assert from "node:assert/strict";
import { build, summary, fmtMem, fmtAge, fmtCpu, shortApp, filterRows, titleOf, statusOf, ended, snapshot, remember, finishedTasks, filterFinished, parentOf, departed } from "./agents-model.js";

assert.deepEqual([fmtMem(1.4 * 1024 * 1024), fmtMem(612 * 1024), fmtMem(null)], ["1.4G", "612M", "-"]);
assert.deepEqual([fmtAge(30e3), fmtAge(42 * 60e3), fmtAge(3 * 3600e3), fmtAge(2 * 86400e3), fmtAge(null)], ["<1m", "42m", "3h", "2d", "-"]);
assert.deepEqual([fmtCpu(14.82), fmtCpu(null)], ["14.8", "-"]);
assert.deepEqual([shortApp("claude-code"), shortApp("antigravity"), shortApp("agy"), shortApp("omp"), shortApp(undefined)], ["claude", "agy", "agy", "omp", "?"]);

const ag = (address, status, space, app = "claude", tab = "a") => ({ address, status, app, program: { key: app, icon: `${app}.svg` }, space, space_name: `sp-${space}`, tab_name: tab });
const agents = [ag("t1", "idle", "s1"), ag("t2", "working", "s1", "codex"), ag("r/t3", "blocked", "s2"), ag("t4", "working", "s1", "claude", "0"), ag("t5", "done", "s1")];
const spaces = [{ id: "s1" }, { id: "s2", machine: "r" }];
const terminals = [{ address: "t2", report: { msg: "building" } }];
const probe = {
  here: { agents: { t2: { cpu: 2, rssKiB: 2048, created_ms: 1000, repo: "api", branch: "main", history: [1, 2] }, t4: { cpu: 5, rssKiB: null, history: [] } } },
  r: { agents: { "r/t3": { cpu: null, rssKiB: 100, history: [] } } },
};
const m = build({ agents, spaces, terminals, probe, now: 3601e3 });
assert.deepEqual(m.rows.map((r) => r.key), ["r/t3", "t4", "t2", "t5", "t1"]); // needs you, working (space/tab), done, idle
const t2 = m.rows.find((r) => r.key === "t2");
assert.deepEqual([t2.word, t2.repo, t2.branch, t2.doing, t2.age, t2.rssKiB], ["working", "api", "main", "building", "1h", 2048]);
assert.deepEqual([m.rows[0].word, m.rows[0].machine, m.rows[0].place, m.rows[0].target], ["needs you", "r", "sp-s2 / a", { terminal: "r/t3" }]);
assert.deepEqual(m.rows.find((r) => r.key === "t2").program, { key: "codex", icon: "codex.svg" });
assert.equal(summary(m), "2 working · claude uses most");
assert.equal(summary(build({ agents, spaces, terminals, probe: {}, now: 0 })), "2 working"); // no CPU yet
assert.deepEqual(filterRows(m.rows, "API main").map((r) => r.key), ["t2"]);
assert.equal(filterRows(m.rows, "").length, m.rows.length);

// Tasks: under their parent row; shell helpers included; a title from the label or the prompt.
assert.equal(titleOf({ argv: ["claude", "-p", "Review src/auth. Then report."] }), "Review src/auth.");
assert.equal(titleOf({ labels: { task: "Port it" }, argv: ["x"] }), "Port it");
assert.equal(parentOf({ address: "r/t9", parent: "t1" }), "r/t1");
const lead = ag("t1", "working", "s1");
const kid = ag("t6", "idle", "s1", "codex");
const tt = [
  { address: "t1" },
  { address: "t6", state: "live", parent: "t1", labels: { task: "Write tests" }, created_ms: 100 },
  { address: "t7", state: "live", parent: "t1", status: "running", labels: { task: "Shell job" }, argv: ["sh"], created_ms: 200 },
  { address: "t8", state: "live", parent: "t6", argv: ["sh"], name: "deep", created_ms: 300 },
];
const tm = build({ agents: [lead, kid, ag("t2", "idle", "s1")], spaces, terminals: tt, probe: {}, now: 3601e3 });
assert.deepEqual(tm.rows.map((r) => [r.key, r.depth]), [["t1", 0], ["t7", 1], ["t6", 1], ["t8", 2], ["t2", 0]]);
assert.deepEqual([tm.rows[1].title, tm.rows[1].word, tm.rows[1].app], ["Shell job", "working", "sh"]);
assert.deepEqual(filterRows(tm.rows, "write tests").map((r) => r.key), ["t6"]);
const loop = build({ agents: [], spaces, terminals: [{ address: "a", state: "live", parent: "b" }, { address: "b", state: "live", parent: "a" }], probe: {}, now: 0 });
assert.equal(loop.rows.length, 2); // a parent cycle still shows

// Ending: killed after idle = finished; exit 1 = failed; a signal = stopped.
assert.deepEqual([{ state: "x", exit_code: 0 }, { state: "x", exit_code: 1 }, { state: "x", signal: "KILL" }, { state: "x", reason: "killed", last_status: "idle" }].map((x) => statusOf(x, new Map())),
  ["finished", "failed", "stopped", "finished"]);
const snap = snapshot({ address: "t9", argv: ["codex", "do the thing now"], created_ms: 1000, status: "working" });
assert.equal(snap.board_title, "do the thing now");
const hist = remember(remember([], ended(snap, { exit_code: 1, finished_ms: 5000 }, 0)), ended({ ...snap, address: "t10" }, {}, 9000));
assert.deepEqual(hist.map((h) => [h.address, h.exit_code, h.finished_ms]), [["t10", null, 9000], ["t9", 1, 5000]]);
assert.equal(remember(hist, hist[1], 1).length, 1);
const fin = finishedTasks({ terminals: [{ address: "t10", state: "live", parent: "t1" }, { address: "t11", state: "exited", parent: "t1", exit_code: 0, finished_ms: 7000, created_ms: 1000 }], history: hist, now: 9500 });
assert.deepEqual(fin.map((f) => [f.key, f.word, f.code]), [["t11", "done", "exit 0"], ["t9", "failed", "exit 1"]]); // t10 is live: its history entry is hidden
assert.deepEqual(filterFinished(fin, "failed thing").map((f) => f.key), ["t9"]);
// A task seen by one render and gone by the next is resolved once.
const seen = new Map(), resolving = new Set();
assert.deepEqual(departed(seen, resolving, [{ address: "q1", labels: { task: "Quick" } }]), []);
assert.deepEqual(departed(seen, resolving, []).map(([a, s]) => [a, s.board_title]), [["q1", "Quick"]]);
assert.deepEqual(departed(seen, resolving, []), []); // already resolving
// "running" tasks count as working in the summary
const rn = build({ agents: [], spaces, terminals: [{ address: "q2", state: "live", parent: "x", status: "running" }], probe: {}, now: 0 });
assert.equal(summary(rn), "1 working");
console.log("ok agents-model");

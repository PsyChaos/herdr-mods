import assert from "node:assert/strict";
import { build, summary, fmtMem, fmtAge, fmtCpu, shortApp } from "./agents-model.js";

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
console.log("ok agents-model");

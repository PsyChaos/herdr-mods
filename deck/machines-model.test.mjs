import assert from "node:assert/strict";
import { size, percent, parseExtras, containerState, dockerCounts, EXTRAS } from "./machines-model.js";
import { execFileSync } from "node:child_process";

assert.deepEqual([size(500 * 1024 ** 2), size(1.5 * 1024 ** 3), size(200 * 1024 ** 3)], ["500 MB", "1.5 GB", "200 GB"]);
assert.deepEqual([percent(1, 4), percent(1, 0)], [25, 0]);
assert.deepEqual(parseExtras('{"docker":null}'), { top: [], swap: { total: 0, used: 0 }, disks: [], docker: null });
assert.throws(() => parseExtras("nope"));

const c = (state, status = "") => ({ state, status });
assert.deepEqual(
  [c("running", "Up 2h (unhealthy)"), c("running", "Up (health: starting)"), c("exited", "Exited (0) 1h ago"), c("exited", "Exited (137) 1h ago"), c("restarting")].map(containerState),
  ["unhealthy", "starting", "exited", "failed", "restarting"],
);
const counts = dockerCounts([c("running"), c("running", "Up (health: starting)"), c("exited", "Exited (0)"), c("created"), c("running", "(unhealthy)"), c("exited", "Exited (1)")]);
assert.deepEqual(counts, [
  { word: "running", count: 2, bad: false }, { word: "stopped", count: 2, bad: false },
  { word: "unhealthy", count: 1, bad: true }, { word: "failed", count: 1, bad: true },
]);
assert.deepEqual(dockerCounts(null), []);

// The script itself runs where python3 and /proc exist.
try {
  const d = parseExtras(execFileSync("python3", ["-I", "-c", EXTRAS], { encoding: "utf8", timeout: 8000 }));
  assert.ok(d.disks.length >= 1 && d.disks.every((x) => x.total >= x.used));
} catch (e) { if (e.code !== "ENOENT") throw e; }
console.log("ok machines-model");

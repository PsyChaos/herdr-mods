import assert from "node:assert/strict";
import { passes, matches, projects, isUp, machineLabel } from "./docker-model.js";

const c = (name, state, extra = {}) => ({ id: name, name, image: "img", state, status: state, ports: [], project: null, folder: null, service: null, ...extra });
const web = c("shop-web-1", "running", { project: "shop", folder: "~/shop", service: "web", ports: ["8080->80"], image: "nginx" });
const db = c("shop-db-1", "exited", { project: "shop", folder: "~/shop", ports: ["5432"], image: "postgres" });
const lone = c("lone", "paused");

assert.deepEqual([isUp(web), isUp(db), isUp(lone), isUp(c("x", "restarting"))], [true, false, true, true]);
assert.deepEqual([web, db, lone].map((x) => [passes("all", x), passes("running", x), passes("stopped", x)]),
  [[true, true, false], [true, false, true], [true, true, false]]);

assert.equal(machineLabel(null), "This computer");
assert.ok(matches(null, web, []));
assert.ok(matches(null, db, ["postgres", ":5432"]));
assert.ok(!matches(null, db, ["postgres", "nginx"])); // every word must match
assert.ok(matches(null, web, ["this", "computer"]));
assert.ok(!matches("box", web, ["computer"]));
assert.ok(matches("box", web, ["box"]));

const groups = projects([lone, db, web]);
assert.deepEqual(groups.map((g) => [g.name, g.up, g.containers.map((x) => x.name)]),
  [["shop", 1, ["shop-db-1", "shop-web-1"]], [null, 1, ["lone"]]]);
assert.deepEqual(projects([db, c("z", "exited"), c("a", "running", { project: "a" })]).map((g) => g.name), ["a", "shop", null]);

console.log("ok docker-model");

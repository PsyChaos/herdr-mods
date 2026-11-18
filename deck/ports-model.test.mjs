import assert from "node:assert/strict";
import { kindOf, isWeb, words, matches, shown, freeLocalPort, stopLines } from "./ports-model.js";

const web = { port: 3000, program: "node", folder: "~/app", command: "node serve.js", pid: 7, local_only: true };
const db = { port: 5432, container: "shop-pg-1", folder: "~/shop" };
const sys = { port: 22, program: "sshd", folder: "/" };
const temp = { port: 40001, program: "node", folder: "~/x" };
assert.deepEqual([web, db, sys, temp].map(kindOf), ["app", "app", "system", "temp"]);
assert.deepEqual([web, db, sys].map(isWeb), [true, false, false]);
assert.deepEqual(words("  Node  3000 "), ["node", "3000"]);
assert.ok(matches(null, web, null, words("node :3000 this")));
assert.ok(!matches("box", web, null, words("node box2")));
assert.ok(matches("box", sys, { where: "tab one" }, words("tab one")));
const all = [web, db, sys, temp];
assert.deepEqual(shown(null, all, "", false, () => null), [web, db]);
assert.equal(shown(null, all, "", true, () => null).length, 4);
assert.deepEqual(shown(null, all, "sshd", false, () => null), [sys]); // search sees hidden ports
assert.equal(freeLocalPort(3000, new Set()), 3000);
assert.equal(freeLocalPort(3000, new Set([3000, 43000])), 43001);
assert.equal(stopLines("box", { ...web, local_only: false }, { where: "a/b" }).length, 4);
console.log("ports-model ok");

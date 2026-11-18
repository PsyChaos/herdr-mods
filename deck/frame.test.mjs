import assert from "node:assert/strict";
import { machineBad, thenNotify, askedTab, SIZES, sizeIndex } from "./frame.js";

const r = { a: { here: "ok", box: "ok" }, b: { box: "error" }, c: null };
assert.equal(machineBad(r, "here"), false);
assert.equal(machineBad(r, "box"), true);
assert.equal(machineBad({ a: { here: "error" } }, "here"), true);
assert.equal(machineBad({}, "box"), false);

const calls = [];
thenNotify((cx) => calls.push("fn"))({ notify: () => calls.push("notify") });
assert.deepEqual(calls, ["fn", "notify"]);
assert.equal(askedTab({ id: "prs", at: 95 }, 0, 100, 10), "prs");
assert.equal(askedTab({ id: "prs", at: 95 }, 95, 100, 10), null); // consumed
assert.equal(askedTab({ id: "prs", at: 80 }, 0, 100, 10), null); // stale
assert.equal(askedTab(undefined, 0, 100, 10), null);
assert.deepEqual([sizeIndex(undefined), sizeIndex(2), sizeIndex(-1), sizeIndex(9), sizeIndex("1")], [0, 2, 0, SIZES.length - 1, 0]);
console.log("ok frame");

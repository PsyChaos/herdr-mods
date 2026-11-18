import assert from "node:assert/strict";
import { machineBad, thenNotify, askedTab } from "./frame.js";

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
console.log("ok frame");

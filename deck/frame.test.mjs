import assert from "node:assert/strict";
import { machineBad, thenNotify } from "./frame.js";

const r = { a: { here: "ok", box: "ok" }, b: { box: "error" }, c: null };
assert.equal(machineBad(r, "here"), false);
assert.equal(machineBad(r, "box"), true);
assert.equal(machineBad({ a: { here: "error" } }, "here"), true);
assert.equal(machineBad({}, "box"), false);

const calls = [];
thenNotify((cx) => calls.push("fn"))({ notify: () => calls.push("notify") });
assert.deepEqual(calls, ["fn", "notify"]);
console.log("ok frame");

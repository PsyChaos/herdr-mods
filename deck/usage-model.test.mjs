import assert from "node:assert/strict";
import { duration, age, resetShort, percentText, parseResult, noteOf, matches } from "./usage-model.js";

const now = new Date(2026, 10, 18, 12, 0).getTime();
assert.deepEqual([duration(30e3), duration(42 * 60e3), duration(3 * 3600e3 + 5 * 60e3), duration(50 * 3600e3)], ["<1m", "42m", "3h 5m", "2d 2h"]);
assert.deepEqual([age("garbage", now), age(new Date(now - 10e3).toISOString(), now), age(new Date(now - 3 * 3600e3).toISOString(), now)], [null, "just now", "3h 0m ago"]);
assert.deepEqual([resetShort(null, now), resetShort(new Date(now - 1).toISOString(), now), resetShort(new Date(2026, 10, 18, 16, 39).getTime(), now), resetShort(new Date(2026, 10, 25).getTime(), now)], ["", "passed", "16:39", "Nov 25"]);
assert.deepEqual([percentText(42), percentText(18.54)], ["42%", "18.5%"]);

const ok = (o) => ({ stdout: `noise\n${JSON.stringify(o)}\n`, code: 0 });
const e = parseResult("r", "demo", ok({ provider: "demo", label: "Demo", plan: "pro", windows: [{ id: "5h", used_percent: 130 }, { id: "x", used_percent: "n/a" }, { id: "w", used_percent: 20, stale: true }], totals: [{ label: "Today", text: "1k" }, { id: "bad" }] }));
assert.deepEqual([e.windows.map((w) => [w.id, w.used_percent, w.stale]), e.totals.length, e.error], [[["5h", 100, false], ["w", 20, true]], 1, null]);
assert.equal(parseResult(null, "demo", ok({ skip: true })).skip, true);
assert.equal(parseResult(null, "demo", ok({ ok: false })).error, "Couldn't read usage");
assert.equal(parseResult(null, "demo", { stdout: "", code: 3 }).error, "Script failed (exit 3)");
assert.equal(parseResult(null, "demo", { stdout: "\n", code: 0 }).error, "Script printed nothing");
assert.equal(parseResult(null, "demo", { stdout: "{", code: 0 }).error, "Output isn't valid JSON");
assert.equal(parseResult(null, "demo", { stdout: "[1]", code: 0 }).windows.length, 0);
assert.equal(parseResult(null, "demo", { failed: new Error("no route") }).error, "no route");

assert.equal(noteOf(e, now), null);
assert.equal(noteOf({ windows: [{ stale: true }], totals: [] }, now), "stale");
assert.equal(noteOf({ windows: [], updated_at: new Date(now - 2 * 3600e3).toISOString() }, now), "2h 0m ago");
assert.deepEqual([matches(e, ""), matches(e, "demo pro"), matches(e, "demo free"), matches(e, "R"), matches({ ...e, machine: null }, "this")], [true, true, false, true, true]);
// Old totals and old errors still get their age note (the view shows it beside the name, not over the detail).
const old = new Date(now - 2 * 3600e3).toISOString();
assert.equal(noteOf({ windows: [], totals: [{ text: "1k" }], updated_at: old }, now), "2h 0m ago");
assert.equal(noteOf({ windows: [], totals: [], error: "boom", updated_at: old }, now), "2h 0m ago");
console.log("ok usage-model");

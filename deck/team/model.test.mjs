import assert from "node:assert/strict";
import { watchThread, readDue, group, repoName, parseLog, wordsOf, addressOn, treeFiles, filterGroup } from "./model.js";
import { buildInbox, searchInbox } from "./inbox.js";
import { overlapText } from "./messages.js";

const agent = (address, over = {}) => ({ address, pane: `p${address}`, program: { name: "Codex" }, space_name: "Work", tab_name: "1", title: "", status: "working", ...over });
const folder = (top, branch, changed) => ({ top, common: "/r/proj/.git", branch, base: "origin/main", ahead: 1, changed: changed.map((path) => ({ path, how: "changed" })), more: 0, committed: [] });
const log = "- 2026-11-04 20:37 t1(claude-code) → t2(codex): fix the parser\n- 2026-11-04 20:40 t2(codex) → all: done";
const results = { "This computer": { machine: null, folders: { t1: folder("~/wt/a", "feat-a", ["src/x.js"]), t2: folder("~/wt/b", "feat-b", ["src/x.js", "README.md"]) }, boards: { "/r/proj/.git": { path: "/r/proj/.git/herdr-team.md", text: log } } } };
const rows = [{ agent: agent("t1"), machine: null, cwd: "/a" }, { agent: agent("t2"), machine: null, cwd: "/b" }, { agent: agent("t9", { title: "idle thing" }), machine: null, cwd: "/z" }];

const view = group(rows, results, (m) => m ?? "This computer");
assert.equal(repoName("/r/proj/.git"), "proj");
assert.equal(view.repos.length, 1);
assert.equal(view.loose.length, 1);
assert.equal(view.repos[0].conflicts[0].paths[0], "src/x.js"); // the shared file is a warning
assert.match(overlapText(agent("t1"), view.repos[0].conflicts[0]), /^\[team\] Heads-up: t2 /);
assert.equal(addressOn("box", agent("t3")), "box/t3");
assert.equal(addressOn("box", agent("box/t3")), "box/t3");
assert.deepEqual(wordsOf("  Feat-B  README "), ["feat-b", "readme"]);

// search: a worktree by branch; file-only words narrow the files
assert.equal(filterGroup(view, wordsOf("feat-b")).repos[0].trees.length, 1);
assert.equal(filterGroup(view, wordsOf("nomatch")).repos.length, 0);
const repo = view.repos[0];
const b = repo.trees.find((t) => t.branch === "feat-b");
assert.deepEqual(treeFiles(repo, b, wordsOf("readme")).map((f) => f.path), ["README.md"]);

// inbox: two threads, unread counts, search keeps matching messages only
assert.equal(parseLog(results["This computer"].boards["/r/proj/.git"]).length, 2);
const inbox = buildInbox(results, {});
assert.equal(inbox[0].unread, 2);
assert.equal(buildInbox(results, { [inbox[0].threads[0].key]: 1 })[0].unread, 1);
const found = searchInbox(inbox, wordsOf("parser"));
assert.equal(found[0].threads.length, 1);
assert.equal(found[0].threads[0].messages.length, 1);

// read timer
const th = (n, unread) => ({ key: "k", messages: Array(n).fill({}), unread });
let w = watchThread(null, th(2, 2), 0);
assert.ok(!readDue(w, 7999)); 
w = watchThread(w, th(2, 2), 4000);
assert.ok(readDue(w, 8000));
let r = watchThread(w, th(2, 0), 8000); // read: timer off
assert.equal(r.since, Infinity);
r = watchThread(r, th(3, 1), 9000); // read conversation gets a new message: fresh timer
assert.equal(r.since, 9000);
r = watchThread(r, th(3, 1), 13000);
assert.ok(!readDue(r, 16999)); assert.ok(readDue(watchThread(r, th(3, 1), 17000), 17000));
let h = watchThread(null, th(2, 2), 0); // hidden (other tab) for 20 s, then drawn again: restarts
h = watchThread(h, th(2, 2), 20000);
assert.equal(h.since, 20000);
assert.ok(!readDue(watchThread(h, th(2, 2), 24000), 24000)); // 4 s since return
assert.ok(!readDue(watchThread(null, th(2, 2), 0), 30000)); // not drawn since: never due
console.log("ok team model");

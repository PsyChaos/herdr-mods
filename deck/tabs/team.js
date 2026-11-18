// Deck's Team tab: the agents working in each repository on every Herdr machine
// (worktree, branch, changed files, clashes) and what they said to each other
// (the herdr-team log as an inbox). See team.md.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, exec, hc, shared, setShared } from "herdr";
import { PROBE, BOARD_FILE, MARK, group, localAddress, wordsOf, addressOn, treeFiles, filterGroup, watchThread, readDue } from "../team/model.js";
import { buildInbox, searchInbox, who } from "../team/inbox.js";
import { agentName, overlapText, sharedText } from "../team/messages.js";
import { panel, textButton, chips, dot, num } from "../ui.js";

const REFRESH_MS = 8000;
const READ_KEY = "team.read";
const FILES_SHOWN = 6; // files a worktree shows before "N more"
const THREAD_SHOWN = 30; // messages a conversation shows before "N earlier"
const CLEAR_SH = ': > "$1"';
// herdr-team introduce in a worktree ("~/x" too), from ~/.local/bin when it isn't on PATH.
const INTRODUCE_SH = 'd="$1"; case "$d" in "~"*) d="$HOME${d#\\~}";; esac; cd "$d" || exit 1; '
  + 'exec "$(command -v herdr-team || echo "$HOME/.local/bin/herdr-team")" introduce';

const machineLabel = (name) => name ?? "This computer";
const readState = () => shared(READ_KEY) ?? {};
const markRead = (thread) => setShared(READ_KEY, { ...readState(), [thread.key]: thread.messages.length });

// UI state lives here, not in what load returns.
const ui = { dialog: null, note: null, mode: "agents", openTrees: new Set(), showAll: null, sending: new Set() };
let results = {}; // machine label -> probe answer, replaced as each machine answers
let reach = {}; // machine name or "here" -> "ok" | "error"
let started = 0;
let shown = null; // watchThread()'s answer for the conversation drawn last

const setNote = (text, level = "info") => { ui.note = { text, level, at: Date.now() }; };
const failed = (e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) });
// Runs argv here or on another machine, never throwing.
const runOn = (machine, argv) => (machine ? hc(["exec", "--on", machine, "--", ...argv]) : exec(argv[0], argv.slice(1))).catch(failed);

const machineOf = (agent) => spaces().find((s) => s.id === agent.space)?.machine ?? null;
function agentRows() {
  const all = panes();
  return agents().map((agent) => ({ agent, machine: machineOf(agent), cwd: all.find((p) => p.pane === agent.pane)?.cwd ?? null }));
}

// Reads every reachable machine in the background (also those without agents: their logs are the inbox).
function refresh(names) {
  started = Date.now();
  const byMachine = new Map(names.map((m) => [m, []]));
  for (const row of agentRows()) {
    if (!byMachine.has(row.machine)) byMachine.set(row.machine, []);
    byMachine.get(row.machine).push([localAddress(row.agent.address), row.cwd]);
  }
  for (const [machine, wanted] of byMachine) {
    const key = machineLabel(machine);
    if (results[key]?.loading) continue;
    results[key] = { ...(results[key] ?? {}), loading: true };
    const probe = machine ? hc(["exec", "--on", machine, "--", "python3", "-I", "-c", PROBE, JSON.stringify(wanted), BOARD_FILE])
      : exec("python3", ["-I", "-c", PROBE, JSON.stringify(wanted), BOARD_FILE]);
    probe.then((answer) => {
      reach[machine ?? "here"] = "ok";
      let parsed = null;
      let error = null;
      try {
        if (answer.code !== 0) throw new Error(answer.stderr?.trim() || "no answer");
        parsed = JSON.parse(answer.stdout);
      } catch (e) {
        error = String(e?.message ?? e).split("\n").pop();
      }
      results = { ...results, [key]: { ...(parsed ?? results[key]), machine, error, loading: false, at: Date.now() } };
    }, () => {
      reach[machine ?? "here"] = "error"; // exec rejected: the machine cannot be reached
      results = { ...results, [key]: { ...results[key], machine, loading: false } };
    });
  }
}

// One model per render: count, blocked, rows and view share it for 100 ms.
let memo = { state: null, at: 0, value: null };
function modelOf(state) {
  const now = Date.now();
  if (memo.state !== state || now - memo.at > 100) {
    const res = state?.results ?? {};
    const inbox = buildInbox(res, readState());
    memo = { state, at: now, value: { res, view: group(agentRows(), res, machineLabel), inbox, unread: inbox.reduce((n, p) => n + p.unread, 0) } };
  }
  return memo.value;
}

// Types each text into its agent's input and submits it (hc send waits while
// someone types there and won't type into an agent waiting on a dialog).
function deliver(id, items, cx) {
  if (ui.sending.has(id) || !items.length) return;
  ui.sending.add(id);
  ui.note = null;
  cx.notify();
  cx.spawn(async (cx) => {
    const out = await Promise.all(items.map(async ({ agent, machine, text }) => {
      const r = await hc(["send", addressOn(machine, agent), text]).catch(failed);
      return r.code === 0 ? null : `${agentName(agent)}: ${(r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.code}`}`;
    }));
    const bad = out.filter(Boolean);
    ui.sending.delete(id);
    if (bad.length) setNote(`Not delivered: ${bad.join(" · ")}`, "error");
    else setNote(`Sent to ${items.length} agent${items.length > 1 ? "s" : ""}.`, "ok");
    cx.notify();
  });
}

// herdr-team introduce on the repository's machine, in one of its worktrees.
function introduce(repo, cx) {
  const id = `intro|${repo.key}`;
  if (ui.sending.has(id)) return;
  ui.sending.add(id);
  ui.note = null;
  cx.notify();
  cx.spawn(async (cx) => {
    const r = await runOn(repo.machine, ["sh", "-c", INTRODUCE_SH, "sh", repo.trees[0].top]);
    const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
    const sent = lines.filter((l) => l.endsWith(": delivered")).length;
    const problems = lines.filter((l) => /NOT delivered|herdr-team:|not found|No such/i.test(l));
    const rules = lines.filter((l) => l.endsWith("rules written")).map((l) => l.split(":")[0]);
    ui.sending.delete(id);
    if (r.code === 0) setNote([`Introduced ${sent} agent${sent === 1 ? "" : "s"}.`, rules.length ? `Rules added to ${rules.join(", ")}.` : ""].filter(Boolean).join(" "), "ok");
    else setNote(problems.join(" · ") || lines.pop() || `herdr-team introduce failed (exit ${r.code})`, "error");
    cx.notify();
  });
}

// Empties a project's log; its conversations start unread from zero again.
function clearLog(project, cx) {
  setShared(READ_KEY, Object.fromEntries(Object.entries(readState()).filter(([k]) => !k.startsWith(`${project.key}#`))));
  cx.spawn(async (cx) => {
    const r = await runOn(project.machine, ["sh", "-c", CLEAR_SH, "sh", project.board.path]);
    if (r.code !== 0) setNote(`The log couldn't be cleared: ${(r.stderr || "").trim() || `exit ${r.code}`}`, "error");
    refresh([null, ...Object.values(results).map((x) => x.machine).filter(Boolean)]);
    cx.notify();
  });
}

const askClear = (project) => {
  ui.dialog = {
    title: "Clear project",
    lines: [`Clear all messages of ${project.name}?`, "The log file is emptied; this cannot be undone."],
    action: "Clear",
    destructive: true,
    onConfirm: (cx) => { ui.dialog = null; clearLog(project, cx); cx.notify(); },
    onCancel: (cx) => { ui.dialog = null; cx.notify(); },
  };
};

// What each mode lists, filtered by the search (the same for rows and view).
function agentList(m, words) {
  const v = filterGroup(m.view, words);
  const out = [];
  for (const repo of v.repos) for (const tree of repo.trees) for (const a of tree.agents) out.push({ agent: a, machine: repo.machine });
  for (const row of v.loose) out.push({ agent: row.agent, machine: row.machine });
  return { v, list: out };
}
const threadList = (m, words) => searchInbox(m.inbox, words).flatMap((p) => p.threads.map((thread) => ({ project: p, thread })));

export default {
  id: "team",
  label: "team",
  icon: "users",
  ui,

  async load({ machines: names }) {
    if (Date.now() - started >= REFRESH_MS) refresh(names);
    // The conversation drawn for 8 s is read.
    if (readDue(shown, Date.now())) {
      markRead(shown);
      shown = { ...shown, since: Infinity };
    }
    return { state: { results }, machines: { ...reach } };
  },

  count: (state) => modelOf(state).view.repos.reduce((n, r) => n + r.trees.reduce((k, tr) => k + tr.agents.length, 0), 0) + modelOf(state).view.loose.length,
  blocked: (state) => modelOf(state).unread > 0,

  rows(state, _probe, query) {
    const m = modelOf(state);
    const words = wordsOf(query);
    if (ui.mode === "messages") return threadList(m, words).map((x) => ({ key: x.thread.key, target: null }));
    return agentList(m, words).list.map((x) => ({ key: x.agent.address, target: addressOn(x.machine, x.agent) }));
  },

  view(state, sel, cx, pick, { t, query }) {
    const m = modelOf(state);
    const words = wordsOf(query);
    const errors = Object.entries(m.res).filter(([, r]) => r.error).map(([label, r]) => `${label}: ${r.error}`);
    const total = this.count(state);
    const head = h_flex().flex_none().px(12).pt(12).gap(8).items_center()
      .child(chips(t, { id: "team-mode", selected: ui.mode === "agents" ? 0 : 1,
        options: [{ label: "agents", count: total }, { label: "messages", count: m.unread }],
        onSelect: (i, cx) => { ui.mode = i ? "messages" : "agents"; cx.notify(); } }));
    const body = ui.mode === "messages" ? messagesView(t, m, words, sel, cx, pick, query) : agentsView(t, m, words, sel, cx, pick, query);
    return v_flex().id("team-body").flex_1().min_h(0).child(head)
      .children(errors.map((e) => div().px(12).pt(6).text_size(11).text_color(t.ansi1).child(e)))
      .child(body);
  },
};

// ---- Agents ----

// "● Codex  t3n · Work / 2 · working"; a click goes to its pane.
function agentRow(t, a, machine, sel, pick) {
  return h_flex().id(`agent-${a.address}`).h(22).px(8).gap(8).items_center().rounded(4).cursor_pointer()
    .when(sel === a.address, (el) => el.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => pick(a.address, cx))
    .child(dot(t, t[a.status] ?? t.dim, 6))
    .child(div().flex_none().font_semibold().child(a.program?.name ?? "agent"))
    .child(div().flex_none().text_color(t.ansi4).child(localAddress(a.address)))
    .when(Boolean(machine), (el) => el.child(div().flex_none().text_color(t.dim).child(machine)))
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${a.space_name} / ${a.tab_name} · ${a.title || a.status}`));
}

// A warning, and "Tell them" to send it to the agents it concerns.
function conflictBox(t, repo, c, i) {
  const text = c.kind === "shared"
    ? `${c.agents.length} agents share ${c.tree.top}: git can't tell whose change is whose.`
    : `${c.paths.length === 1 ? c.paths[0] : `${c.paths.length} files`} changed in ${c.sides.length} worktrees (${c.sides.map((s) => s.branch ?? "detached").join(", ")}): their merges will conflict.`;
  const who2 = c.kind === "shared" ? c.agents : c.sides.flatMap((s) => s.agents);
  const id = `warn|${repo.key}|${i}`;
  const items = who2.map((agent) => ({ agent, machine: repo.machine, text: c.kind === "shared" ? sharedText(agent, c) : overlapText(agent, c) }));
  const busy = ui.sending.has(id);
  return v_flex().px(8).py(6).gap(3).rounded(6).border(1).border_color(t.blocked)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).text_color(t.blocked).child(text))
      .child(textButton(t, { id, label: busy ? "Sending…" : "Tell them", disabled: busy, onPress: (cx) => deliver(id, items, cx) })))
    .when(c.kind === "overlap" && c.paths.length > 1, (el) => el.child(div().text_size(11).text_color(t.dim).truncate()
      .child(c.paths.slice(0, 6).join(", ") + (c.paths.length > 6 ? ", …" : ""))));
}

// A worktree: its branch and folder, its agents, and the files it changed.
function treeBlock(t, repo, tree, words, sel, pick) {
  const id = `${repo.key}|${tree.top}`;
  const files = treeFiles(repo, tree, words);
  const open = ui.openTrees.has(id);
  const list = open ? files : files.slice(0, FILES_SHOWN);
  const hidden = files.length - list.length + (tree.more ?? 0);
  const ahead = tree.ahead ? ` · ${tree.ahead} commits on top of ${tree.base}` : "";
  return v_flex().gap(2)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_none().font_semibold().child(tree.branch ?? "detached HEAD"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${tree.top}${ahead}`)))
    .children(tree.agents.map((a) => agentRow(t, a, null, sel, pick)))
    .when(!files.length, (el) => el.child(div().pl(8).text_color(t.dim).child("no changes")))
    .children(list.map((f) => h_flex().pl(8).gap(8)
      .child(div().flex_none().w(10).text_color(f.how === "conflict" ? t.blocked : f.how === "committed" ? t.dim : t.ansi4).child(MARK[f.how]))
      .child(div().flex_1().min_w(0).truncate().text_color(f.how === "committed" ? t.dim : t.muted).child(f.path))))
    .when(hidden > 0 || open, (el) => el.child(h_flex().pl(8).child(textButton(t, { id: `more-${id}`, label: open ? "show fewer" : `${hidden} more`,
      onPress: (cx) => { if (open) ui.openTrees.delete(id); else ui.openTrees.add(id); cx.notify(); } }))));
}

function agentsView(t, m, words, sel, _cx, pick, query) {
  const { v } = agentList(m, words);
  const panels = v.repos.map((repo) => {
    const count = repo.trees.reduce((n, tree) => n + tree.agents.length, 0);
    const right = [repo.machine, `${repo.trees.length} worktree${repo.trees.length > 1 ? "s" : ""}`, `${count} agent${count > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
    const id = `intro|${repo.key}`;
    const busy = ui.sending.has(id);
    return panel(t, { id: `repo-${repo.key}`, icon: "git-branch", title: repo.name, right, body: [
      count > 1 ? h_flex().justify_end().child(textButton(t, { id, label: busy ? "Sending…" : "Introduce", disabled: busy, onPress: (cx) => introduce(repo, cx) })) : null,
      ...(words.length ? [] : repo.conflicts.map((c, i) => conflictBox(t, repo, c, i))),
      ...repo.trees.map((tree) => treeBlock(t, repo, tree, words, sel, pick)),
    ] });
  });
  if (v.loose.length) {
    const reading = v.loose.some((row) => !m.res[machineLabel(row.machine)]?.at);
    panels.push(panel(t, { id: "loose", icon: "users", title: reading ? "Reading their folders…" : "Not in a git repository",
      body: v.loose.map((row) => agentRow(t, row.agent, row.machine, sel, pick)) }));
  }
  if (!panels.length) {
    const text = words.length ? `Nothing matches "${query.trim()}". Esc clears the search.` : "No agents are running.";
    panels.push(panel(t, { id: "none", icon: "users", title: "agents", body: div().text_color(t.dim).child(text) }));
  }
  return v_flex().id("team-list").flex_1().min_h(0).pb(12).overflow_y_scrollbar().children(panels);
}

// ---- Messages ----

const badge = (t, n) => div().flex_none().px(5).rounded(8).text_size(10).bg(t.ansi4).text_color(t.background).child(String(n));

function threadRow(t, p, thread, on, whole, pick) {
  const last = thread.messages[thread.messages.length - 1];
  return v_flex().id(`thread-${thread.key}`).px(6).py(3).gap(1).rounded(4).cursor_pointer()
    .when(on, (el) => el.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { ui.showAll = null; if (whole?.unread) markRead(whole); pick(thread.key, cx); })
    .child(h_flex().gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().when(thread.unread > 0, (el) => el.font_semibold()).child(thread.label))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(last.time))
      .when(thread.unread > 0, (el) => el.child(badge(t, thread.unread))))
    .child(div().truncate().text_size(11).text_color(t.dim).child(`${who(last.from, p.programs)}: ${last.text}`));
}

// "t3x Codex → t3w Claude   20:38" over the text, on a card.
function messageCard(t, p, msg) {
  const to = msg.to.address === "all" ? "everyone" : who(msg.to, p.programs);
  return v_flex().id(`m-${p.key}-${msg.i}`).px(8).py(5).gap(2).rounded(6).bg(t.background)
    .child(h_flex().gap(6).items_center()
      .child(div().flex_none().font_semibold().child(who(msg.from, p.programs)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`→ ${to}`))
      .child(num(t, msg.time, t.dim)))
    .child(div().text_color(t.muted).child(msg.text));
}

function messagesView(t, m, words, sel, _cx, pick, query) {
  const projects = searchInbox(m.inbox, words);
  if (!projects.length) {
    const text = m.inbox.length ? `No message matches "${query.trim()}". Esc clears the search.` : 'No messages yet. Agents send them with herdr-team say; "Introduce" tells them how.';
    return v_flex().id("team-list").flex_1().min_h(0).child(panel(t, { id: "none", icon: "users", title: "messages", body: div().text_color(t.dim).child(text) }));
  }
  const all = projects.flatMap((p) => p.threads.map((thread) => ({ project: p, thread })));
  const chosen = all.find((x) => x.thread.key === sel) ?? all[0];
  const whole = new Map(m.inbox.flatMap((p) => p.threads.map((x) => [x.key, x])));
  const full = whole.get(chosen.thread.key);
  shown = watchThread(shown, full, Date.now());
  const left = v_flex().id("inbox-list").flex_none().w(300).h_full().overflow_y_scrollbar().pb(12)
    .children(projects.map((p) => panel(t, { id: `proj-${p.key}`, icon: "archive", title: p.name,
      right: [p.machine, p.unread ? `${p.unread} new` : ""].filter(Boolean).join(" · "),
      body: p.threads.map((thread) => threadRow(t, p, thread, thread.key === chosen.thread.key, whole.get(thread.key), pick)) })));
  return h_flex().id("team-list").flex_1().min_h(0).child(left).child(conversation(t, chosen.project, chosen.thread, words));
}

// The chosen conversation, oldest first; a day line where the date changes.
function conversation(t, p, thread, words) {
  const open = ui.showAll === thread.key || words.length > 0;
  const list = open ? thread.messages : thread.messages.slice(-THREAD_SHOWN);
  const hidden = thread.messages.length - list.length;
  const rows = [];
  let day = null;
  for (const msg of list) {
    if (msg.date !== day) { day = msg.date; rows.push(div().pt(4).text_size(10).text_color(t.dim).child(day)); }
    rows.push(messageCard(t, p, msg));
  }
  const right = [p.machine, `${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  return v_flex().id("conversation").flex_1().min_w(0).h_full().overflow_y_scrollbar().pb(12)
    .child(panel(t, { id: "conv", icon: "users", title: thread.label, right, body: [
      h_flex().justify_end().gap(8)
        .when(hidden > 0, (el) => el.child(textButton(t, { id: "earlier", label: `${hidden} earlier`, onPress: (cx) => { ui.showAll = thread.key; cx.notify(); } })))
        .child(textButton(t, { id: "clear", label: "Clear project", destructive: true, onPress: (cx) => { askClear(p); cx.notify(); } })),
      ...rows,
    ] }));
}

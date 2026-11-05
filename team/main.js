// Agent team: the agents working in each repository, on every Herdr machine,
// side by side — which worktree and branch each is on and the files it
// changed — and, in "Messages", what they said to each other as an inbox.
//
// Agents talk with the herdr-team command (team/herdr-team, in ~/.local/bin):
// `herdr-team say <address|all> "…"` types a message into another agent's
// input. "Introduce" runs `herdr-team introduce` there: it writes the rules into
// the agents' instructions files when missing and tells every agent of the
// repository who the others are and how to reach them. A warning shows when two agents share a folder or change
// the same file in different worktrees; "Tell them" sends it to those agents.
// "Agents" lists who works where; its search filters repositories, worktrees,
// agents and files. "Messages" (inbox-view.js) is an inbox: projects and their
// conversations on the left, the chosen one on the right; its search filters
// the messages.
// Runs as a window: ctrl-shift-d ("mod.open:team").

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, panes, spaces, machines, exec, hc, run, theme, props, closeOverlay, setShared } from "herdr";
import { PROBE, BOARD_FILE, MARK, filesOf, group, matches, localAddress } from "./model.js";
import { buildInbox } from "./inbox.js";
import { inboxTab, readState, markRead } from "./inbox-view.js";
import { agentName, overlapText, sharedText } from "./messages.js";

const REFRESH_MS = 8000;
// Files a worktree shows before "N more".
const FILES_SHOWN = 6;
const CLEAR_SH = ': > "$1"';
// herdr-team introduce in a worktree ("~/x" too), from ~/.local/bin when it isn't on PATH.
const INTRODUCE_SH = 'd="$1"; case "$d" in "~"*) d="$HOME${d#\\~}";; esac; cd "$d" || exit 1; '
  + 'exec "$(command -v herdr-team || echo "$HOME/.local/bin/herdr-team")" introduce';

const machineLabel = (name) => name ?? "This computer";

// Runs argv here or on another machine, never throwing.
function runOn(machine, argv) {
  const failed = (e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) });
  return machine
    ? hc(["exec", "--on", machine, "--", ...argv]).catch(failed)
    : exec(argv[0], argv.slice(1)).catch(failed);
}

export default class Team extends View {
  init(_props, cx) {
    this.results = {};
    this.openTrees = new Set();
    this.clearing = null; // the project whose log asks "Sure?"
    this.sending = new Set(); // repositories (or warnings) being sent
    this.note = null; // { text, bad }
    this.tab = "agents"; // or "messages"
    this.selected = null; // the conversation shown in Messages
    this.showAll = null; // the conversation showing its earlier messages
    this.shown = null; // the conversation on screen, marked read on refresh
    this.search = InputState.new({ placeholder: "Search: repo, branch, agent, t3n, file… (Messages: what was said)" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.focus();
    cx.timer.after(600, () => this.search.focus());
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => {
      if (this.tab === "messages" && this.shown?.unread) markRead(this.shown);
      this.refresh(cx);
    });
  }

  machineOf(agent) {
    return spaces().find((s) => s.id === agent.space)?.machine ?? null;
  }

  // hc's address for an agent, machine-qualified for another machine.
  addressOf(agent) {
    const machine = this.machineOf(agent);
    return machine && !agent.address.includes("/") ? `${machine}/${agent.address}` : agent.address;
  }

  // Every agent with its machine and its pane's folder.
  rows() {
    const all = panes();
    return agents().map((agent) => ({ agent, machine: this.machineOf(agent), cwd: all.find((p) => p.pane === agent.pane)?.cwd ?? null }));
  }

  refresh(cx) {
    // Every reachable machine is read, also without agents: its logs are the inbox.
    const byMachine = new Map([[null, []], ...machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => [m.name, []])]);
    for (const row of this.rows()) {
      if (!byMachine.has(row.machine)) byMachine.set(row.machine, []);
      byMachine.get(row.machine).push([localAddress(row.agent.address), row.cwd]);
    }
    for (const [machine, wanted] of byMachine) {
      const key = machineLabel(machine);
      const current = this.results[key];
      if (current?.loading) continue;
      this.results[key] = { ...(current ?? {}), loading: true };
      cx.spawn(async (cx) => {
        const answer = await runOn(machine, ["python3", "-I", "-c", PROBE, JSON.stringify(wanted), BOARD_FILE]);
        let parsed = null;
        let error = null;
        try {
          if (answer.code !== 0) throw new Error(answer.stderr?.trim() || "no answer");
          parsed = JSON.parse(answer.stdout);
        } catch (e) {
          error = String(e?.message ?? e).split("\n").pop();
        }
        this.results[key] = { ...(parsed ?? this.results[key]), machine, error, loading: false, at: Date.now() };
        cx.notify();
      });
    }
    cx.notify();
  }

  // Types each text into its agent's input and submits it (hc send waits while
  // someone types there and won't type into an agent waiting on a dialog).
  deliver(id, items, cx) {
    if (this.sending.has(id) || !items.length) return;
    this.sending.add(id);
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const results = await Promise.all(items.map(async ({ agent, text }) => {
        const r = await hc(["send", this.addressOf(agent), text]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
        return r.code === 0 ? null : `${agentName(agent)}: ${(r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.code}`}`;
      }));
      const failed = results.filter(Boolean);
      this.sending.delete(id);
      this.note = failed.length
        ? { text: `Not delivered: ${failed.join(" · ")}`, bad: true }
        : { text: `Sent to ${items.length} agent${items.length > 1 ? "s" : ""}.`, bad: false };
      cx.notify();
    });
  }

  // herdr-team introduce on the repository's machine, in one of its worktrees.
  introduce(repo, cx) {
    const id = `intro|${repo.key}`;
    if (this.sending.has(id)) return;
    this.sending.add(id);
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await runOn(repo.machine, ["sh", "-c", INTRODUCE_SH, "sh", repo.trees[0].top]);
      const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
      const sent = lines.filter((l) => l.endsWith(": delivered")).length;
      const problems = lines.filter((l) => /NOT delivered|herdr-team:|not found|No such/i.test(l));
      const rules = lines.filter((l) => l.endsWith("rules written")).map((l) => l.split(":")[0]);
      this.sending.delete(id);
      this.note = r.code === 0
        ? { text: [`Introduced ${sent} agent${sent === 1 ? "" : "s"}.`, rules.length ? `Rules added to ${rules.join(", ")}.` : ""].filter(Boolean).join(" "), bad: false }
        : { text: problems.join(" · ") || lines.pop() || `herdr-team introduce failed (exit ${r.code})`, bad: true };
      this.refresh(cx);
    });
  }

  // Empties a project's log; its conversations start unread from zero again.
  clearLog(repo, cx) {
    this.clearing = null;
    const read = readState();
    setShared("team.read", Object.fromEntries(Object.entries(read).filter(([k]) => !k.startsWith(`${repo.key}#`))));
    cx.spawn(async (cx) => {
      const r = await runOn(repo.machine, ["sh", "-c", CLEAR_SH, "sh", repo.board.path]);
      this.note = r.code === 0 ? null : { text: `The log couldn't be cleared: ${(r.stderr || "").trim() || `exit ${r.code}`}`, bad: true };
      this.refresh(cx);
    });
  }

  button(t, id, label, onClick, enabled = true) {
    return div()
      .id(id)
      .px(6)
      .py(1)
      .rounded(5)
      .flex_none()
      .text_size(11)
      .text_color(enabled ? t.muted : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick))
      // A press that isn't stopped drags the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(label);
  }

  dot(t, status) {
    return div().flex_none().w(7).h(7).rounded(4).bg(t[status] ?? t.dim);
  }

  words() {
    return this.search.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // "Agents" / "Messages (N)": which list shows.
  tabButton(t, id, label) {
    const on = this.tab === id;
    return div().id(`tab-${id}`).px(8).py(1).rounded(5).flex_none().text_size(11.5).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.raised ?? t.hover))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.tab = id; cx.notify(); })
      .child(label);
  }

  header(t, view, unread) {
    const overlay = props()?.overlay;
    const warnings = view.repos.reduce((n, r) => n + r.conflicts.length, 0);
    const parts = [`${agents().length} agents`, `${view.repos.length} repos`];
    if (warnings) parts.push(`${warnings} warnings`);
    return h_flex().h(32).flex_none().px(10).gap(6).items_center().text_size(12).border_b(1).border_color(t.border)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Agent team"))
      .child(this.tabButton(t, "agents", "Agents"))
      .child(this.tabButton(t, "messages", unread ? `Messages · ${unread} new` : "Messages"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(warnings ? t.blocked : t.dim).child(parts.join(" · ")))
      .child(this.button(t, "refresh", "↻", (_e, cx) => this.refresh(cx)))
      .when(Boolean(overlay), (el) => el.child(this.button(t, "close", "✕", () => closeOverlay(overlay))));
  }

  // "● Codex  t3n · Vensift / 2 · working"; a click goes to its pane.
  agentRow(t, agent, id) {
    return h_flex().id(id).pl(26).pr(10).py(1).gap(6).items_center().text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("pane.focus", { pane: agent.pane }))
      .child(this.dot(t, agent.status))
      .child(div().flex_none().text_color(t.foreground).child(agent.program?.name ?? "agent"))
      .child(div().flex_none().text_size(10.5).text_color(t.accent).child(localAddress(agent.address)))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
        .child(`${agent.space_name} / ${agent.tab_name} · ${agent.title || agent.status}`));
  }

  // A worktree: its branch and folder, its agents, and the files it changed.
  treeRows(t, repo, tree, words) {
    const id = `${repo.key}|${tree.top}`;
    const every = filesOf(tree);
    // Search words found only in file names show just the files they name.
    const rest = this.treeText(repo, { ...tree, changed: [], committed: [] }).toLowerCase();
    const fileWords = words.filter((w) => !rest.includes(w));
    const named = fileWords.length ? every.filter((f) => matches(fileWords, f.path)) : every;
    const files = named.length ? named : every;
    const open = this.openTrees.has(id);
    const shown = open ? files : files.slice(0, FILES_SHOWN);
    const ahead = tree.ahead ? ` · ${tree.ahead} commits on top of ${tree.base}` : "";
    const rows = [
      h_flex().px(10).pl(18).pt(4).gap(6).items_center().text_size(11)
        .child(div().flex_none().text_color(t.foreground).child(tree.branch ?? "detached HEAD"))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(`${tree.top}${ahead}`)),
      ...tree.agents.map((a) => this.agentRow(t, a, `agent-${a.address}`)),
    ];
    if (!files.length) rows.push(div().pl(26).text_size(10.5).text_color(t.dim).child("no changes"));
    rows.push(...shown.map((f) => h_flex().pl(26).pr(10).gap(6).text_size(10.5)
      .child(div().flex_none().w(10).text_color(f.how === "conflict" ? t.blocked : f.how === "committed" ? t.dim : t.accent).child(MARK[f.how]))
      .child(div().flex_1().min_w(0).truncate().text_color(f.how === "committed" ? t.dim : t.muted).child(f.path))));
    const hidden = files.length - shown.length + (tree.more ?? 0);
    if (hidden > 0 || open) {
      rows.push(div().id(`more-${id}`).pl(42).text_size(10.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { if (open) this.openTrees.delete(id); else this.openTrees.add(id); cx.notify(); })
        .child(open ? "show fewer" : `${hidden} more`));
    }
    return rows;
  }

  // A warning, and "Tell them" to send it to the agents it concerns.
  conflictRow(t, repo, c, i) {
    const text = c.kind === "shared"
      ? `${c.agents.length} agents share ${c.tree.top}: git can't tell whose change is whose.`
      : `${c.paths.length === 1 ? c.paths[0] : `${c.paths.length} files`} changed in ${c.sides.length} worktrees (${c.sides.map((s) => s.branch ?? "detached").join(", ")}): their merges will conflict.`;
    const who = c.kind === "shared" ? c.agents : c.sides.flatMap((s) => s.agents);
    const id = `warn|${repo.key}|${i}`;
    const items = who.map((agent) => ({ agent, text: c.kind === "shared" ? sharedText(agent, c) : overlapText(agent, c) }));
    return v_flex().mx(10).ml(18).mt(4).px(8).py(4).gap(2).rounded(6).border_1().border_color(t.blocked)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.blocked).child(`⚠ ${text}`))
        .child(this.button(t, id, this.sending.has(id) ? "Sending…" : "Tell them", (_e, cx) => this.deliver(id, items, cx), !this.sending.has(id))))
      .when(c.kind === "overlap" && c.paths.length > 1, (el) => el.child(div().text_size(10).text_color(t.dim).truncate()
        .child(c.paths.slice(0, 6).join(", ") + (c.paths.length > 6 ? ", …" : ""))));
  }

  // The text a search looks in for one worktree.
  treeText(repo, tree) {
    return [repo.name, repo.machine ?? "", tree.branch ?? "detached", tree.top,
      ...tree.agents.map((a) => `${localAddress(a.address)} ${a.program?.name ?? ""} ${a.space_name} ${a.tab_name} ${a.title} ${a.status}`),
      ...filesOf(tree).map((f) => f.path)].join(" ");
  }

  repoSection(t, repo, words) {
    // While searching: the worktrees that match, or nothing.
    const trees = repo.trees.filter((tree) => matches(words, this.treeText(repo, tree)));
    if (words.length && !trees.length) return [];
    const count = repo.trees.reduce((n, tree) => n + tree.agents.length, 0);
    const where = [repo.machine, `${repo.trees.length} worktree${repo.trees.length > 1 ? "s" : ""}`, `${count} agent${count > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
    const id = `intro|${repo.key}`;
    return [
      h_flex().mt(8).px(10).py(4).gap(6).items_center().bg(t.raised ?? t.hover)
        .child(div().flex_none().font_semibold().text_size(12.5).text_color(t.foreground).child(repo.name))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(where))
        .when(count > 1, (el) => el.child(this.button(t, id, this.sending.has(id) ? "Sending…" : "Introduce",
          (_e, cx) => this.introduce(repo, cx), !this.sending.has(id)))),
      ...(words.length ? [] : repo.conflicts.map((c, i) => this.conflictRow(t, repo, c, i))),
      ...trees.flatMap((tree) => this.treeRows(t, repo, tree, words)),
    ];
  }

  // The Agents tab: repositories, their worktrees and agents, then the rest.
  agentsTab(t, view, words) {
    const sections = view.repos.flatMap((repo) => this.repoSection(t, repo, words));
    const loose = view.loose.filter((row) => matches(words, `${localAddress(row.agent.address)} ${row.agent.program?.name ?? ""} ${row.agent.space_name} ${row.agent.tab_name} ${row.agent.title}`));
    if (words.length && !sections.length && !loose.length) {
      sections.push(div().px(10).py(12).text_size(11).text_color(t.dim).child(`Nothing matches "${this.search.value().trim()}". Esc clears the search.`));
    }
    if (loose.length) {
      const reading = view.loose.some((row) => !this.results[machineLabel(row.machine)]?.at);
      sections.push(h_flex().mt(8).px(10).py(4).bg(t.raised ?? t.hover).text_size(12.5).font_semibold().text_color(t.foreground)
        .child(reading ? "Reading their folders…" : "Not in a git repository"));
      sections.push(...loose.map((row) => this.agentRow(t, row.agent, `loose-${row.agent.address}`)));
    }
    if (!agents().length) sections.push(div().px(10).py(12).text_size(11).text_color(t.dim).child("No agents are running."));
    return v_flex().id("team-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar().children(sections);
  }

  render(_props, cx) {
    const t = theme();
    const view = group(this.rows(), this.results, machineLabel);
    const words = this.words();
    const errors = Object.entries(this.results).filter(([, r]) => r.error)
      .map(([label, r]) => div().px(10).pt(6).text_size(10.5).text_color(t.blocked).child(`${label}: ${r.error}`));
    const inbox = this.tab === "messages" ? inboxTab(this, t, words) : null;
    const unread = inbox?.unread ?? buildInbox(this.results, readState()).reduce((n, p) => n + p.unread, 0);
    return v_flex()
      .id("team")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.search.value()) this.search.set_value("");
        else closeOverlay(props()?.overlay);
        cx.stop_propagation();
        cx.notify();
      })
      .size_full()
      .text_size(13)
      .child(this.header(t, view, unread))
      .child(div().flex_none().px(10).pt(8).pb(4)
        .child(Input.new(this.search).h(30).px(9).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(12).text_color(t.foreground)))
      .children(errors)
      .child(inbox ? inbox.body : this.agentsTab(t, view, words))
      .child(h_flex().flex_none().px(10).py(5).gap(6).border_t(1).border_color(t.border).text_size(10)
        .child(div().flex_1().min_w(0).truncate().text_color(this.note?.bad ? t.blocked : t.dim)
          .child(this.note?.text ?? "Agents talk with herdr-team; \"Introduce\" tells them who else works in their repository.")));
  }
}

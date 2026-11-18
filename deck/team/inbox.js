// The Messages tab's model: every repository's log as an inbox. A repository
// (project) holds conversations: one per pair of agents, and "Everyone" for
// messages sent to all. Pure: built from the probes' answers.

import { parseLog, repoName, matches } from "./model.js";

const PROGRAM = { "claude-code": "Claude", claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi", gemini: "Gemini" };

// "t3w Claude", "you" for the user, the address when the program is unknown.
export function who(p, programs) {
  if (p.address === "user") return "you";
  const program = p.program ?? programs.get(p.address);
  return program ? `${p.address} ${PROGRAM[program] ?? program}` : p.address;
}

const stamp = (m) => `${m.date} ${m.time}`;

// results: machine label → probe answer ({boards, machine}).
// read: thread key → messages already seen.
// → projects, newest activity first, each with its threads, newest first.
export function buildInbox(results, read) {
  const projects = [];
  for (const [label, answer] of Object.entries(results)) {
    for (const [common, board] of Object.entries(answer.boards ?? {})) {
      const messages = parseLog(board).filter((m) => m.date);
      if (!messages.length) continue;
      const key = `${label}|${common}`;
      // A program seen once names that address everywhere in the project.
      const programs = new Map();
      for (const m of messages) for (const p of [m.from, m.to]) if (p.program) programs.set(p.address, p.program);
      const threads = new Map();
      for (const m of messages) {
        const pair = m.to.address === "all" ? ["all"] : [m.from.address, m.to.address].sort();
        const id = `${key}#${pair.join("+")}`;
        if (!threads.has(id)) {
          threads.set(id, { key: id, everyone: pair[0] === "all", parties: pair[0] === "all" ? [] : pair, messages: [] });
        }
        threads.get(id).messages.push(m);
      }
      const list = [...threads.values()].map((t) => ({
        ...t,
        label: t.everyone ? "Everyone" : t.parties.map((a) => who({ address: a, program: null }, programs)).join(" ↔ "),
        last: t.messages[t.messages.length - 1],
        unread: Math.max(0, t.messages.length - (read[t.key] ?? 0)),
      })).sort((a, b) => stamp(b.last).localeCompare(stamp(a.last)));
      projects.push({ key, name: repoName(common), machine: answer.machine ?? null, board, programs, threads: list,
        last: list[0].last, unread: list.reduce((n, t) => n + t.unread, 0) });
    }
  }
  return projects.sort((a, b) => stamp(b.last).localeCompare(stamp(a.last)));
}

// The text a search looks in for one message.
export const messageText = (project, m) =>
  `${project.name} ${m.date} ${m.time} ${who(m.from, project.programs)} ${who(m.to, project.programs)} ${m.text}`;

// The projects and threads with a message matching every word, each thread
// keeping only those messages.
export function searchInbox(projects, words) {
  if (!words.length) return projects;
  return projects.map((project) => ({
    ...project,
    threads: project.threads
      .map((t) => ({ ...t, messages: t.messages.filter((m) => matches(words, `${messageText(project, m)} ${t.label}`)) }))
      .filter((t) => t.messages.length),
  })).filter((project) => project.threads.length);
}

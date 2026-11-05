// The Messages tab, drawn for the Agent team window: projects and their
// conversations on the left, the chosen conversation on the right, oldest
// message first. Unread counts live in shared("team.read") (thread key →
// messages seen), so they survive closing the window.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared, setShared } from "herdr";
import { buildInbox, searchInbox, who } from "./inbox.js";

const READ_KEY = "team.read";
// Messages a conversation shows before "N earlier".
const THREAD_SHOWN = 30;
const LIST_W = 230;

export const readState = () => shared(READ_KEY) ?? {};

export function markRead(thread) {
  setShared(READ_KEY, { ...readState(), [thread.key]: thread.messages.length });
}

// view: the window (results, selected, showAll, clearing, button(), clearLog()).
// Sets view.shown to the conversation on screen (whole, not the search's part),
// which the window marks read on its next refresh; a click marks it at once.
// → { body, unread } for the tab and its header badge.
export function inboxTab(view, t, words) {
  const all = buildInbox(view.results, readState());
  const unread = all.reduce((n, p) => n + p.unread, 0);
  const projects = searchInbox(all, words);
  if (!projects.length) {
    const text = all.length
      ? `No message matches "${view.search.value().trim()}". Esc clears the search.`
      : 'No messages yet. Agents send them with herdr-team say; "Introduce" tells them how.';
    return { unread, body: div().px(10).py(12).text_size(11).text_color(t.dim).child(text) };
  }
  const threads = projects.flatMap((p) => p.threads.map((thread) => ({ project: p, thread })));
  const chosen = threads.find((x) => x.thread.key === view.selected) ?? threads[0];
  const whole = new Map(all.flatMap((p) => p.threads.map((x) => [x.key, x])));
  view.shown = whole.get(chosen.thread.key) ?? null;
  return {
    unread,
    body: h_flex().flex_1().min_h(0)
      .child(v_flex().id("inbox-list").flex_none().w(LIST_W).h_full().border_r(1).border_color(t.border).overflow_y_scrollbar().pb(8)
        .children(projects.flatMap((p) => [projectRow(t, p), ...p.threads.map((thread) => threadRow(view, t, p, thread, thread.key === chosen.thread.key, whole.get(thread.key)))])))
      .child(conversation(view, t, chosen.project, chosen.thread, words)),
  };
}

const badge = (t, n) => div().flex_none().px(5).rounded(8).text_size(9.5).bg(t.accent).text_color(t.accent_foreground ?? t.background).child(String(n));

function projectRow(t, p) {
  return h_flex().mt(6).px(10).py(3).gap(6).items_center().bg(t.raised ?? t.hover)
    .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).text_color(t.foreground).child(p.name))
    .when(Boolean(p.machine), (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(p.machine)))
    .when(p.unread > 0, (el) => el.child(badge(t, p.unread)));
}

// "t3w Claude ↔ t3x Codex   20:38" over "t3x Codex: README.md…".
function threadRow(view, t, p, thread, on, full) {
  const last = thread.messages[thread.messages.length - 1];
  return v_flex().id(`thread-${thread.key}`).px(10).pl(16).py(3).gap(1).cursor_pointer()
    .when(on, (el) => el.bg(t.selected ?? t.hover))
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { view.selected = thread.key; view.clearing = null; if (full?.unread) markRead(full); cx.notify(); })
    .child(h_flex().gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground)
        .when(thread.unread > 0, (el) => el.font_semibold()).child(thread.label))
      .child(div().flex_none().text_size(9.5).text_color(t.dim).child(last.time))
      .when(thread.unread > 0, (el) => el.child(badge(t, thread.unread))))
    .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${who(last.from, p.programs)}: ${last.text}`));
}

// The chosen conversation, oldest first; a day line where the date changes.
function conversation(view, t, p, thread, words) {
  const open = view.showAll === thread.key || words.length > 0;
  const shown = open ? thread.messages : thread.messages.slice(-THREAD_SHOWN);
  const hidden = thread.messages.length - shown.length;
  const clearing = view.clearing === p.key;
  const rows = [];
  let day = null;
  for (const m of shown) {
    if (m.date !== day) {
      day = m.date;
      rows.push(div().pt(8).pb(2).text_size(9.5).text_color(t.dim).child(day));
    }
    rows.push(message(t, p, m));
  }
  return v_flex().flex_1().min_w(0).h_full()
    .child(h_flex().flex_none().px(10).py(5).gap(6).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().font_semibold().text_size(12).text_color(t.foreground).child(thread.label))
        .child(div().truncate().text_size(10).text_color(t.dim)
          .child([p.name, p.machine, `${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"}`].filter(Boolean).join(" · "))))
      .child(view.button(t, `clear-${p.key}`, clearing ? `Sure? Clear all of ${p.name}` : "Clear project",
        (_e, cx) => { if (clearing) view.clearLog(p, cx); else { view.clearing = p.key; cx.notify(); } })))
    .child(v_flex().id(`conv-${thread.key}`).flex_1().min_h(0).px(10).pb(8).overflow_y_scrollbar()
      .when(hidden > 0, (el) => el.child(view.button(t, `earlier-${thread.key}`, `${hidden} earlier`,
        (_e, cx) => { view.showAll = thread.key; cx.notify(); })))
      .children(rows));
}

// "t3x Codex → t3w Claude   20:38" over the text, on a raised card.
function message(t, p, m) {
  const to = m.to.address === "all" ? "everyone" : who(m.to, p.programs);
  return v_flex().id(`m-${p.key}-${m.i}`).mt(4).px(8).py(4).gap(2).rounded(7).bg(t.raised ?? t.hover)
    .child(h_flex().gap(6).items_center().text_size(10.5)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(who(m.from, p.programs)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`→ ${to}`))
      .child(div().flex_none().text_size(9.5).text_color(t.dim).child(m.time)))
    .child(div().text_size(11.5).text_color(t.muted).child(m.text));
}

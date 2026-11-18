// Deck's usage tab: every provider's rate-limit windows on this computer and on
// each machine. Readers are deck/usage/sources/<provider>.sh (see usage/CONTRACT.md).
// Reads every 2 minutes in the background; a reading is kept in module scope.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, machines as hostMachines, exec, readTextFile } from "herdr";
import { panel, table, meter, num, rowButton } from "../ui.js";
import { parseResult, noteOf, matches, percentText, resetShort } from "../usage-model.js";

const REFRESH_MS = 2 * 60 * 1000;
const SOURCES = "mods/deck/usage/sources";
const keyOf = (machine) => machine ?? "here";

let cache = null; // {entries, note}
let status = {}; // "here" | machine -> "ok" | "error"
let running = false;
let lastAt = 0;

async function readAll(names) {
  const listing = await exec("sh", ["-c", 'for f in "$1"/*.sh; do [ -f "$f" ] && basename "$f" .sh; done', "sh", `${appHome()}/${SOURCES}`]).catch(() => null);
  const providers = (listing?.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const layout = new Map(hostMachines().map((m) => [m.name ?? null, m.layout]));
  const entries = [];
  const bad = {};
  await Promise.all(providers.map(async (provider) => {
    let text;
    try {
      text = await readTextFile(`${appHome()}/${SOURCES}/${provider}.sh`);
      if (text == null || !text.trim()) throw new Error("script missing or empty");
      text = text.replace(/\x1b/g, ""); // keep it a plain sh -c argument
    } catch (e) {
      entries.push({ machine: null, provider, label: provider, windows: [], totals: [], error: `Can't read script (${e?.message ?? e})` });
      return;
    }
    // Local runs the file; another machine gets the text, since it keeps no copy.
    await Promise.all(names.map(async (m) => {
      if (["unavailable", "loading"].includes(layout.get(m))) {
        entries.push({ machine: m, provider, label: provider, windows: [], totals: [], wait: true });
        return;
      }
      const result = await (m ? exec("sh", ["-c", text], { on: m }) : exec("sh", [`${appHome()}/${SOURCES}/${provider}.sh`])).catch((failed) => ({ failed }));
      if (result.failed) bad[keyOf(m)] = true;
      const e = parseResult(m, provider, result);
      if (!e.skip) entries.push(e);
    }));
  }));
  entries.sort((a, b) => a.provider.localeCompare(b.provider));
  return { entries, note: providers.length ? null : `No scripts: expected ${SOURCES}/<provider>.sh`, bad };
}

function refresh(names, cx) {
  if (running) return;
  running = true;
  cx?.notify();
  readAll(names).then((r) => {
    cache = { entries: r.entries, note: r.note };
    status = Object.fromEntries(names.map((m) => [keyOf(m), r.bad[keyOf(m)] ? "error" : "ok"]));
    lastAt = Date.now();
  }).catch(() => { lastAt = Date.now(); }).finally(() => { running = false; cx?.notify(); });
}

const visible = (state, query) => (state?.entries ?? []).filter((e) => matches(e, query));

export default {
  id: "usage",
  label: "usage",
  icon: "activity",

  async load({ machines, state }) {
    if (!running && Date.now() - lastAt >= REFRESH_MS) refresh(machines);
    return { state: cache ?? state, machines: status };
  },

  count: (state) => (state?.entries ?? []).length,
  blocked: () => false,
  rows: (state, _probe, query) => visible(state, query).map((e) => ({ key: `${keyOf(e.machine)}|${e.provider}` })),

  view(state, sel, _cx, pick, { t, query }) {
    const entries = visible(state, query);
    const names = [...new Set(entries.map((e) => e.machine ?? null))];
    const order = hostMachines().map((m) => m.name ?? null);
    names.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const refreshBtn = rowButton(t, { id: "usage-refresh", icon: "refresh-cw", tooltip: running ? "Reading…" : "Refresh now", disabled: running, onPress: (cx2) => refresh(order, cx2) });
    const columns = [
      { label: "provider", w: 140 }, { label: "window", w: 70 }, { label: "used", w: 176 },
      { label: "", w: 46, align: "right" }, { label: "resets", w: 60 }, { label: "" },
    ];
    const panels = names.map((m, i) => {
      const rows = [];
      for (const e of entries.filter((x) => (x.machine ?? null) === m)) {
        const key = `${keyOf(m)}|${e.provider}`;
        const note = e.wait ? "connecting…" : noteOf(e);
        const name = h_flex().gap(6).min_w(0).child(div().truncate().font_semibold().text_color(e.error ? t.blocked : t.foreground).child(e.label))
          .when(Boolean(e.plan), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(String(e.plan))));
        // Each line: window, bar, percent, reset, text at the end.
        const lines = [
          ...e.windows.map((w) => [w.label ?? w.id ?? "?", div().opacity(w.stale ? 0.4 : 1).child(meter(t, w.used_percent, 24, "mem")),
            num(t, percentText(w.used_percent), w.stale ? t.muted : t.foreground, 46), resetShort(w.resets_at), ""]),
          ...e.totals.map((x) => [x.label, "", "", "", x.text]),
        ];
        if (e.error) lines.push(["", "", "", "", div().truncate().text_color(t.blocked).child(e.error)]);
        else if (!lines.length) lines.push(["", "", "", "", div().text_color(t.dim).child(e.wait ? "" : "no data")]);
        if (note) lines[0][4] = div().text_color(t.dim).child(note);
        lines.forEach((l, j) => rows.push({ key: j ? `${key}#${j}` : key, cells: [j ? "" : name, ...l], onClick: (_e, cx2) => pick(key, cx2) }));
      }
      return panel(t, { id: `usage-${keyOf(m)}`, icon: "activity", title: m ?? "this computer", right: i === 0 ? refreshBtn : "", body: table(t, columns, rows, sel) });
    });
    const empty = state == null || (!entries.length && !query)
      ? div().text_color(t.dim).child(state?.note ?? (running || state == null ? "Reading usage…" : "No providers."))
      : !entries.length ? div().text_color(t.dim).child("No match.") : null;
    return v_flex().id("usage-body").flex_1().min_h(0).pb(12).overflow_y_scrollbar()
      .children(panels)
      .when(Boolean(empty), (el) => el.child(panel(t, { id: "usage", icon: "activity", title: "usage", right: refreshBtn, body: empty })));
  },
};

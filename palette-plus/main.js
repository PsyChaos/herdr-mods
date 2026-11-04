// Herdr's command palette with a "Mods" group: every mod you open with a key
// ("mod.open:<name>" in keys.json), and these mods, by name with their key.
// Bind it in place of Herdr's: "ctrl-shift-p": "mod.open:palette-plus".
//
// base.js is Herdr's own palette (frame/palette/main.js), copied by sync.sh:
// a mod can't import a file outside its folder. Herdr rewrites its palette on
// every start, so each opening compares the two and re-copies when Herdr's
// changed; the new copy is used from the next opening.

import Palette, { entries, fuzzy, GROUPS } from "./base.js";
import { keys, exec, appHome, readTextFile } from "herdr";

const SELF = "palette-plus";
// Shown even without a key; [title, search words].
const KNOWN = {
  ports: ["Ports", "listening port kill stop tunnel localhost server"],
  ci: ["PRs & CI", "pull request github actions checks build failed"],
  machines: ["Machines", "cpu memory ram disk docker containers load"],
  browser: ["Open in browser", "web page url file html localhost"],
  "task-board": ["Task board", "tasks helpers agents"],
  "usage-board": ["Usage", "limits tokens claude codex opencode quota"],
};
// The "Mods" group comes right after "Recent".
const ORDER = [GROUPS[0], "Mods", ...GROUPS.slice(1)];

// `herdr`: the entries Herdr's palette already has; a mod it names ("Go to
// space or tab…" is the picker) isn't listed twice.
function modEntries(herdr) {
  const named = new Set(herdr.filter((e) => e.name === "mod.open").map((e) => e.args?.name));
  const names = new Set(Object.keys(KNOWN));
  for (const k of keys()) {
    const m = k.section === "global" && k.action.match(/^mod\.open:(.+)$/);
    if (m && m[1] !== SELF) names.add(m[1]);
  }
  for (const name of named) names.delete(name);
  return [...names].map((name) => {
    const [title, words] = KNOWN[name] ?? [name.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase()), ""];
    const args = { name };
    return { name: "mod.open", args, group: "Mods", title, words: `mod ${name} ${words}`, id: `mod.open:${JSON.stringify(args)}` };
  });
}

export default class PalettePlus extends Palette {
  init(props, cx) {
    super.init(props, cx);
    cx.spawn(async () => {
      const app = appHome();
      const [theirs, ours] = await Promise.all([
        readTextFile(`${app}/frame/palette/main.js`).catch(() => null),
        readTextFile(`${app}/mods/${SELF}/base.js`).catch(() => null),
      ]);
      if (theirs && ours && !ours.startsWith(theirs)) {
        await exec("sh", [`${app}/mods/${SELF}/sync.sh`, app]).catch(() => null);
      }
    });
  }

  // Herdr's rows() with the mods added: grouped when empty, ranked while typing.
  rows() {
    const herdr = entries();
    const all = [...herdr, ...modEntries(herdr)];
    const q = this.query.trim().toLowerCase().replace(/\s+/g, "");
    if (!q) {
      const recent = this.recent.map((id) => all.find((e) => e.id === id)).filter(Boolean).slice(0, 5);
      const rest = ORDER.slice(1).flatMap((g) => all.filter((e) => e.group === g && !recent.includes(e)));
      const others = all.filter((e) => !ORDER.includes(e.group) && !recent.includes(e));
      return [...recent.map((e) => ({ e, head: "Recent" })), ...[...rest, ...others].map((e) => ({ e, head: e.group }))];
    }
    const rank = (e) => this.recent.indexOf(e.id);
    return all
      .map((e) => {
        const title = fuzzy(q, e.title);
        const more = fuzzy(q, `${e.group} ${e.title} ${e.name} ${e.words}`);
        const best = title ?? (more && { score: more.score - 4, hits: [] });
        return best && { e, score: best.score, hits: best.hits };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || (rank(a.e) < 0 ? 99 : rank(a.e)) - (rank(b.e) < 0 ? 99 : rank(b.e)));
  }
}

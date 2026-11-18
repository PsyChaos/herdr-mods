// Pure helpers of the Deck frame (no host imports, so node can test them).

// A tab reports a machine only when it cannot reach it: any non-"ok" entry is an error.
// results: tab id -> {machine: "ok"|"error"}; this computer is "here".
export const machineBad = (results, name) => Object.values(results).some((r) => r?.[name] !== undefined && r[name] !== "ok");

// A button handler that redraws after the callback (which clears ui.dialog itself).
export const thenNotify = (fn) => (cx) => { fn(cx); cx.notify(); };

// The tab id asked for by shared("deck.tab") ({id, at}) when it is fresh and newer than `consumed`, else null.
export const askedTab = (want, consumed, now, maxAge) => (want?.at > now - maxAge && want.at > consumed ? want.id : null);

// Window sizes (S is mod.json's). The chosen one is kept in shared("deck.size") as an index.
export const SIZES = [
  { label: "S", width: 980, height: 620 },
  { label: "M", width: 1200, height: 760 },
  { label: "L", width: 1440, height: 880 },
  { label: "XL", width: 1720, height: 980 },
];
export const sizeIndex = (i) => (Number.isInteger(i) ? Math.max(0, Math.min(SIZES.length - 1, i)) : 0);

// Deck draws its own window frame (mod.json frame "none"), so its corners can follow the
// layout: the smallest pane radius it names (Arcade's 0 is square), else 8.
export function cornerRadius(node) {
  const radii = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.pane?.radius === "number") radii.push(n.pane.radius);
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  walk(node);
  return radii.length ? Math.min(...radii) : 8;
}

// Without Herdr's frame nothing paints behind Deck: theme colors with alpha (#rrggbbaa) become opaque.
export const solid = (c) => (typeof c === "string" && /^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : c);

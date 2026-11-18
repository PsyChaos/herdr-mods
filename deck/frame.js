// Pure helpers of the Deck frame (no host imports, so node can test them).

// A tab reports a machine only when it cannot reach it: any non-"ok" entry is an error.
// results: tab id -> {machine: "ok"|"error"}; this computer is "here".
export const machineBad = (results, name) => Object.values(results).some((r) => r?.[name] !== undefined && r[name] !== "ok");

// A button handler that redraws after the callback (which clears ui.dialog itself).
export const thenNotify = (fn) => (cx) => { fn(cx); cx.notify(); };

// The tab id asked for by shared("deck.tab") ({id, at}) when it is fresh and newer than `consumed`, else null.
export const askedTab = (want, consumed, now, maxAge) => (want?.at > now - maxAge && want.at > consumed ? want.id : null);

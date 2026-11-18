// Pure logic of Deck's ports tab (from the old ports mod): what is shown, search, stop warnings.

export const EPHEMERAL_FROM = 32768;
const NOT_WEB = new Set([22, 25, 53, 631, 1025, 3306, 3307, 5037, 5353, 5355, 5432, 5433, 6379, 6380, 11211, 27017]);
const NOT_WEB_NAME = /(postgres|mariadb|mysql|redis|mongo|-pg|_db_|-db-|mailpit-smtp)/i;

export const machineLabel = (name) => name ?? "This computer";
export const portId = (machine, p) => `${machineLabel(machine)}-${p.port}`;

// "app": a container, or a program in a folder under home; "temp": a port a program picked for itself; the rest is the system's.
export function kindOf(p) {
  if (p.container) return "app";
  if (p.port >= EPHEMERAL_FROM) return "temp";
  if (p.program && p.folder && p.folder.startsWith("~/")) return "app";
  return "system";
}

export const isWeb = (p) => !NOT_WEB.has(p.port) && !NOT_WEB_NAME.test(p.container ?? "");

export const words = (query) => (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

// Every word must appear in :port, container, program, folder, command, terminal (where, name) or machine.
export function matches(machine, p, term, ws) {
  if (!ws.length) return true;
  const text = [`:${p.port}`, p.container, p.program, p.folder, p.command, term?.where, term?.name, machineLabel(machine)]
    .filter(Boolean).join(" ").toLowerCase();
  return ws.every((w) => text.includes(w));
}

// Ports shown for one machine: a search looks through everything, else `all` decides.
export function shown(machine, ports, query, all, termOf) {
  const ws = words(query);
  if (ws.length) return ports.filter((p) => matches(machine, p, termOf(p), ws));
  return all ? ports : ports.filter((p) => kindOf(p) === "app");
}

// A port on this computer for a tunnel: the same number when free, else one above 40000.
export function freeLocalPort(port, used) {
  if (!used.has(port)) return port;
  for (let c = 40000 + (port % 10000); ; c += 1) if (!used.has(c)) return c;
}

export function stopLines(machine, p, term) {
  const what = p.container ? `container ${p.container} (docker stop)` : `${p.program ?? "the program"} (pid ${p.pid})`;
  return [
    `Stop ${what} on ${machineLabel(machine)}, listening on :${p.port}?`,
    p.container ? "Its other ports stop too; a restart policy may start it again." : "This ends the whole program, not only this port.",
    term ? `It runs in Herdr terminal ${term.where ?? term.address}.` : null,
    !p.local_only ? "Other computers use it over the network too." : null,
  ].filter(Boolean);
}

// Calls check() until it is true, sleeping `step` ms between tries, for at most `total` ms.
export async function pollUntil(check, sleep, total, step) {
  for (let waited = 0; waited < total; waited += step) {
    if (await check()) return true;
    await sleep(step);
  }
  return false;
}

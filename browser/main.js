// Opens a web page, or a file (HTML, image, PDF...), in terminal-browser
// (https://terminal-browser.com), in a pane to the right of the focused one.
//
// The browser always runs on this computer, where Herdr draws it. For another
// machine it runs with `--ssh <machine>`: every request goes out from there,
// so that machine's own localhost (a dev server) opens without port forwarding.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, focused, spaces, machines, terminals, panes, hc, exec, shared, setShared } from "herdr";

const LAST_URL = "browser.last-url";
// {url, machine, at} from another mod; older than this, it's stale and ignored.
const BROWSER_REQUEST = "browser.request";
const REQUEST_FRESH_MS = 5000;
const PANE_WAIT_MS = 4000;
const POLL_MS = 50;
const SERVER_WAIT_S = "10";
// A file server whose browser never closed (say Herdr crashed) still stops on its own.
const SERVER_LIFETIME = "12h";

// Serves one folder on 127.0.0.1, at a free port, and prints that port.
const SERVE_PY = [
  "import functools, http.server, sys",
  "handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])",
  "server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)",
  "print('serving port', server.server_address[1], flush=True)",
  "server.serve_forever()",
].join("\n");

// Finds a path on the machine (a leading ~ is its home) and prints its folder,
// its name (empty for a folder) and its kind.
const RESOLVE_SH = [
  'p=$1',
  'case $p in "~") p=$HOME ;; "~/"*) p=$HOME/${p#"~/"} ;; esac',
  '[ -e "$p" ] || { echo "No such file: $1" >&2; exit 3; }',
  '[ -r "$p" ] || { echo "Not readable: $1" >&2; exit 3; }',
  'if [ -d "$p" ]; then cd "$p" && printf "%s\\n\\nfolder\\n" "$PWD"',
  'else cd "$(dirname "$p")" && printf "%s\\n%s\\nfile\\n" "$PWD" "$(basename "$p")"; fi',
].join("\n");

// Stops the file server once the browser in front of it ends, also when its
// pane is closed.
const CLEANUP_SH = [
  'trap \'hc kill "$SERVER" >/dev/null 2>&1; hc rm "$SERVER" >/dev/null 2>&1\' EXIT',
  "trap 'exit 129' HUP INT TERM",
  '"$@"',
].join("\n");

const isPath = (text) => /^(\/|~|\.\.?\/)/.test(text);

const machineOfSpace = (id) => spaces().find((s) => s.id === id)?.machine ?? null;

// Polls `test` until it returns true or PANE_WAIT_MS passes.
async function waitFor(test, cx) {
  for (let waited = 0; waited < PANE_WAIT_MS; waited += POLL_MS) {
    if (test()) return true;
    await cx.sleep(POLL_MS);
  }
  return test();
}

export default class Browser extends View {
  init(_props, cx) {
    this.before = focused();
    this.machine = this.before ? machineOfSpace(this.before.space) : null;
    this.targets = {};
    this.error = null;
    this.busy = false;
    this.installed = true;

    // Another mod (ports) can ask for an address on a machine: it opens at once.
    const asked = shared(BROWSER_REQUEST);
    const request = asked && Date.now() - (asked.at ?? 0) < REQUEST_FRESH_MS ? asked : null;
    if (asked) setShared(BROWSER_REQUEST, null);
    if (request) this.machine = request.machine ?? null;

    const last = request?.url ?? shared(LAST_URL) ?? "";
    this.input = InputState.new({ placeholder: "localhost:3000, an address, or a file path (~/page.html)", value: last });
    if (last) this.input.set_selected_range({ start: 0, end: last.length });
    this.input.on("submit", (_e, cx) => this.open(cx));
    this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => {
      const found = await exec("sh", ["-c", "command -v terminal-browser"]).catch(() => null);
      this.installed = found?.code === 0;
      const list = await hc(["machine", "ls", "--json"]).catch(() => null);
      try {
        for (const m of JSON.parse(list?.stdout ?? "{}").machines ?? []) this.targets[m.name] = m.target || m.name;
      } catch { /* names are used as ssh targets then */ }
      cx.notify();
      if (request) this.open(cx);
    });
  }

  argv(url, server) {
    const argv = ["env", "DO_NOT_TRACK=1", "TERMINAL_BROWSER_NO_TELEMETRY=1", "terminal-browser", "open", "--no-merge"];
    if (this.machine) argv.push("--ssh", this.targets[this.machine] ?? this.machine);
    if (!server) return [...argv, url];
    return ["env", `SERVER=${server}`, "sh", "-c", CLEANUP_SH, "sh", ...argv, url];
  }

  // A file is shown through a short-lived web server on its machine, in its
  // folder, so a page's own images and styles load too. The browser reaches it
  // as that machine's localhost.
  async serveFile(path) {
    const on = this.machine ? ["--on", this.machine] : [];
    const where = this.machine ?? "this computer";
    const found = await hc(["exec", ...on, "--", "sh", "-c", RESOLVE_SH, "sh", path]);
    if (found.code !== 0) throw new Error(found.stderr.trim() || `Couldn't read ${path} on ${where}.`);
    const [dir, name] = found.stdout.split("\n");

    const started = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", ...on, "--",
      "timeout", SERVER_LIFETIME, "python3", "-c", SERVE_PY, dir]);
    if (started.code !== 0) throw new Error(started.stderr.trim() || `The file server didn't start on ${where}.`);
    const server = JSON.parse(started.stdout).address;

    await hc(["wait", server, "--output", "serving port", "--timeout", SERVER_WAIT_S]);
    const port = (await hc(["read", server])).stdout.match(/serving port (\d+)/)?.[1];
    if (!port) {
      await this.stopServer(server);
      throw new Error(`The file server didn't start on ${where} (it needs python3).`);
    }
    return { url: `http://127.0.0.1:${port}/${encodeURIComponent(name)}`, server };
  }

  async stopServer(server) {
    await hc(["kill", server]).catch(() => null);
    await hc(["rm", server]).catch(() => null);
  }

  open(cx) {
    const url = this.input.value().trim();
    if (!url || this.busy) return;
    if (!this.installed) { this.error = "terminal-browser is not installed on this computer."; cx.notify(); return; }
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.start(url, cx);
        setShared(LAST_URL, url);
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.busy = false;
        cx.notify();
      }
    });
  }

  // Starts the browser as a terminal here, then gives it a pane beside the one
  // that was focused when this dialog opened.
  async start(input, cx) {
    const file = isPath(input) ? await this.serveFile(input) : null;
    const url = file?.url ?? input;
    const result = await hc(["run", "--bg", "--json", "--", ...this.argv(url, file?.server)]);
    if (result.code !== 0) {
      if (file) await this.stopServer(file.server);
      throw new Error(result.stderr.trim() || "The browser didn't start.");
    }
    const address = JSON.parse(result.stdout).address;
    // Herdr learns about a new terminal a moment after hc starts it; keeping it
    // before then fails with "no running terminal".
    const seen = await waitFor(() => terminals().some((t) => t.address === address && t.state === "live"), cx);
    if (!seen) {
      if (file) await this.stopServer(file.server);
      throw new Error("The browser exited right away. Try it in a terminal: terminal-browser open " + url);
    }
    const shown = () => panes().some((p) => p.terminal === address);
    // "right" needs a pane in focus. With a layout block focused (no pane), or
    // when Herdr refuses it, the browser gets a tab of its own instead.
    if (this.before?.pane) {
      run("pane.focus", { pane: this.before.pane });
      run("terminal.keep", { terminal: address, place: "right" });
      if (await waitFor(shown, cx)) return;
    }
    run("terminal.keep", { terminal: address });
    if (await waitFor(shown, cx)) return;
    // Never leave a browser (and its file server) running where nobody sees it.
    await hc(["kill", address]).catch(() => null);
    await hc(["rm", address]).catch(() => null);
    if (file) await this.stopServer(file.server);
    throw new Error("Herdr couldn't give the browser a pane. Click a terminal pane and try again.");
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render(_props, cx) {
    const t = theme();
    const choices = [null, ...machines().map((m) => m.name).filter(Boolean)];
    const chip = (name) => {
      const on = name === this.machine;
      return h_flex().id(`br-m-${name ?? "here"}`).h(28).px(10).items_center().rounded(7).cursor_pointer()
        .border_1().border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised)
        .text_size(12).text_color(on ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.machine = name; cx.notify(); })
        .child(name ?? "This computer");
    };
    const hint = isPath(this.input.value().trim())
      ? `Shows the file from ${this.machine ?? "this computer"} through a temporary local server that stops when the pane closes.`
      : this.machine
        ? `Runs here, but pages load through ${this.machine}, so localhost means that machine.`
        : "Runs and loads pages on this computer.";
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .when(this.busy && primary, (el) => el.opacity(0.6))
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);

    return v_flex().id("browser").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Open in browser"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Address or file"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Load through"))
      .child(h_flex().gap(6).flex_wrap().children(choices.map(chip)))
      .child(div().pt(8).text_size(11.5).text_color(t.dim).child(hint))
      .when(!this.installed, (el) => el.child(div().pt(10).text_size(11.5).text_color(t.blocked)
        .child("terminal-browser isn't installed: curl -fsSL https://terminal-browser.sh/install | bash")))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("br-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("br-open", this.busy ? "Opening…" : "Open", true, (_e, cx) => this.open(cx))));
  }
}

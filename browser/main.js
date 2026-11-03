// Opens a web page in terminal-browser (https://terminal-browser.com), in a
// pane to the right of the focused one.
//
// The browser always runs on this computer, where Herdr draws it. For another
// machine it runs with `--ssh <machine>`: every request goes out from there,
// so that machine's own localhost (a dev server) opens without port forwarding.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, focused, spaces, machines, terminals, panes, hc, exec, shared, setShared } from "herdr";

const LAST_URL = "browser.last-url";
const PANE_WAIT_MS = 4000;
const POLL_MS = 50;

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

    const last = shared(LAST_URL) ?? "";
    this.input = InputState.new({ placeholder: "localhost:3000, a port, or any address", value: last });
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
    });
  }

  argv(url) {
    const argv = ["env", "DO_NOT_TRACK=1", "TERMINAL_BROWSER_NO_TELEMETRY=1", "terminal-browser", "open", "--no-merge"];
    if (this.machine) argv.push("--ssh", this.targets[this.machine] ?? this.machine);
    return [...argv, url];
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
  async start(url, cx) {
    const result = await hc(["run", "--bg", "--json", "--", ...this.argv(url)]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "The browser didn't start.");
    const address = JSON.parse(result.stdout).address;
    // Herdr learns about a new terminal a moment after hc starts it; keeping it
    // before then fails with "no running terminal".
    const seen = await waitFor(() => terminals().some((t) => t.address === address && t.state === "live"), cx);
    if (!seen) throw new Error("The browser exited right away. Try it in a terminal: terminal-browser open " + url);
    if (this.before?.pane) run("pane.focus", { pane: this.before.pane });
    run("terminal.keep", { terminal: address, place: "right" });
    await waitFor(() => panes().some((p) => p.terminal === address), cx);
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
    const hint = this.machine
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
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Address"))
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

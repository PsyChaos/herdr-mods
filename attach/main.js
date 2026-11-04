// Add files: pick files (or drop them on this window) and put them in an
// agent's input, unsent, the way Ctrl+V puts a copied image there.
//
// Each file goes in as its path, one paste per file: Claude Code and Codex
// turn a pasted image path into an attached image ([Image #1]), and read any
// other file from its path. For an agent on another machine the file is first
// sent beside it with `hc put` (over Herdr's own connection), and the path it
// landed at there is pasted. A local file whose name a terminal would split
// (spaces, quotes) goes through `hc put` too, which gives it a plain name.
//
// The paste goes through the clipboard (Herdr's terminal.paste), so the
// clipboard is saved first and put back afterwards (Wayland, wl-clipboard).
// Nothing is sent to the agent: press Enter there yourself.
// Runs as a window: ctrl-shift-a ("mod.open:attach").

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, exec, hc, run, theme, props, closeOverlay } from "herdr";

// How long Herdr gets to move focus to the agent's pane before the first paste,
// and how long each paste gets before the next one replaces the clipboard.
const FOCUS_MS = 250;
const PASTE_GAP_MS = 150;

const COPY_SH = 'printf "%s" "$1" | { wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || pbcopy; }';
// Saves the clipboard to $1 and prints its type (an image first, else text);
// prints nothing when it's empty or there is no wl-paste.
const SAVE_SH = 'types=$(wl-paste --list-types 2>/dev/null) || exit 0; '
  + 'for k in image/png image/jpeg "text/plain;charset=utf-8" text/plain UTF8_STRING; do '
  + 'printf "%s\\n" "$types" | grep -qxF "$k" && { wl-paste -n -t "$k" > "$1" 2>/dev/null && printf "%s" "$k"; exit 0; }; done';
// Detached and not waited for: wl-copy can keep Herdr's exec waiting for seconds.
const RESTORE_SH = 'setsid -f sh -c \'[ -s "$1" ] && wl-copy -t "$2" < "$1"; rm -f "$1"\' sh "$1" "$2" </dev/null >/dev/null 2>&1';
// For each argument, in order: "d" (folder), "f<TAB>size" (file) or "x" (gone).
const INFO_SH = 'for p; do if [ -d "$p" ]; then echo d; elif [ -f "$p" ]; then printf "f\\t%s\\n" "$(stat -c %s "$p" 2>/dev/null || echo 0)"; else echo x; fi; done';

// A path a terminal won't split; others are escaped (folders) or renamed by hc put (files).
const PLAIN_PATH = /^[\w./~+@%,:=-]+$/;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

const escapePath = (p) => p.replace(/[^\w./~+@%,:=-]/g, (c) => `\\${c}`);
const baseName = (p) => p.replace(/\/+$/, "").split("/").pop() || p;
const dirName = (p) => p.replace(/\/[^/]*$/, "") || "/";

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default class Attach extends View {
  init(_props, cx) {
    this.files = [];
    this.chosen = null; // an agent's address; null: the focused one
    this.busy = false;
    this.note = null; // { text, bad }
    this.lastDir = null;
    this.handle = cx.focus_handle();
    cx.timer.after(300, () => this.handle.focus?.());
  }

  // Agents: the focused one first, then the most recently active.
  agentList() {
    return [...agents()].sort((a, b) => (b.focused - a.focused) || (b.seq - a.seq));
  }

  target() {
    const list = this.agentList();
    return list.find((a) => a.address === this.chosen) ?? list[0] ?? null;
  }

  machineOf(agent) {
    return spaces().find((s) => s.id === agent.space)?.machine ?? null;
  }

  // hc's address for the agent's terminal, machine-qualified for another machine.
  addressOf(agent) {
    const machine = this.machineOf(agent);
    return machine && !agent.address.includes("/") ? `${machine}/${agent.address}` : agent.address;
  }

  // New paths (picked or dropped) join the list with their kind and size.
  // Promise callbacks get no cx of their own, so async work runs in cx.spawn.
  add(paths, cx) {
    const fresh = [...new Set(paths)].filter((p) => p && !this.files.some((f) => f.path === p));
    if (!fresh.length) return;
    this.lastDir = dirName(fresh[fresh.length - 1]);
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", INFO_SH, "sh", ...fresh]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      const info = r.stdout.split("\n");
      const added = fresh.map((path, i) => {
        const [kind, size] = (info[i] ?? "x").split("\t");
        return { path, name: baseName(path), kind: kind || "x", size: Number(size) || 0 };
      });
      this.files = [...this.files, ...added];
      this.note = r.code === 0 ? null : { text: r.stderr.trim(), bad: true };
      cx.notify();
    });
  }

  pick(cx) {
    const args = ["--file-selection", "--multiple", "--separator=\n", "--title=Add files to an agent"];
    if (this.lastDir) args.push(`--filename=${this.lastDir}/`);
    cx.spawn(async (cx) => {
      const r = await exec("zenity", args).catch(() => null);
      if (!r) this.note = { text: "No file picker: install zenity, or drop files on this window.", bad: true };
      else if (r.code === 0) this.add(r.stdout.split("\n").filter(Boolean), cx);
      else if (r.code !== 1) this.note = { text: r.stderr.trim() || "The file picker didn't open.", bad: true };
      cx.notify();
    });
  }

  remove(path, cx) {
    this.files = this.files.filter((f) => f.path !== path);
    cx.notify();
  }

  // The text to paste for one file: { path } or { error }.
  async place(file, agent) {
    const machine = this.machineOf(agent);
    if (file.kind === "x") return { error: `${file.name} is gone` };
    if (file.kind === "d") {
      return machine ? { error: `${file.name} is a folder; only files can go to ${machine}` } : { path: escapePath(file.path) };
    }
    if (!machine && PLAIN_PATH.test(file.path)) return { path: file.path };
    const r = await hc(["put", "--json", this.addressOf(agent), file.path]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) return { error: `${file.name}: ${(r.stderr || r.stdout).trim().split("\n").pop() || "couldn't be sent"}` };
    try {
      return { path: escapePath(JSON.parse(r.stdout).path) };
    } catch {
      return { error: `${file.name}: hc put said ${r.stdout.trim()}` };
    }
  }

  copy(text) {
    return exec("sh", ["-c", COPY_SH, "sh", text]).then((r) => r.code === 0).catch(() => false);
  }

  // What "Adding…" is waiting for, shown on the button.
  setStep(step, cx) {
    this.step = step;
    cx.notify();
  }

  send(cx) {
    const agent = this.target();
    if (!agent || !this.files.length || this.busy) return;
    this.busy = true;
    this.note = null;
    // Read now: props() isn't this window's any more once the task awaits.
    const overlay = props()?.overlay;
    cx.notify();
    cx.spawn(async (cx) => {
      const files = this.files;
      const errors = [];
      let placed = files.map(() => ({ error: "not sent" }));
      try {
        const machine = this.machineOf(agent);
        this.setStep(machine ? `Sending to ${machine}…` : "Preparing…", cx);
        placed = await Promise.all(files.map((f) => this.place(f, agent)));
        errors.push(...placed.filter((p) => p.error).map((p) => p.error));
        const paths = placed.filter((p) => p.path).map((p) => p.path);
        if (paths.length) await this.paste(agent, paths, errors, cx);
      } catch (e) {
        errors.push(String(e?.message ?? e));
      }
      this.busy = false;
      this.step = null;
      // Files that went in leave the list; the window closes when all did.
      this.files = files.filter((_f, i) => placed[i].error);
      if (!errors.length) { if (overlay) closeOverlay(overlay); cx.notify(); return; }
      const went = placed.filter((p) => p.path).length;
      const name = `${agent.program?.name ?? "the agent"} in ${agent.space_name}`;
      this.note = { text: `${went ? `${went} added to ${name}. ` : ""}${errors.join(" · ")}`, bad: true };
      cx.notify();
    });
  }

  // Into the agent's input through the clipboard, which is saved and put back.
  async paste(agent, paths, errors, cx) {
    this.setStep("Saving the clipboard…", cx);
    const saved = await this.tempFile();
    const type = (await exec("sh", ["-c", SAVE_SH, "sh", saved]).catch(() => ({ stdout: "" }))).stdout.trim();
    this.setStep("Pasting…", cx);
    run("pane.focus", { pane: agent.pane });
    await cx.sleep(FOCUS_MS);
    // Path, space, path…, then a space to type after.
    for (const text of [...paths.flatMap((p, i) => (i ? [" ", p] : [p])), " "]) {
      if (!(await this.copy(text))) { errors.push("The clipboard couldn't be used (wl-copy)."); break; }
      run("terminal.paste");
      await cx.sleep(PASTE_GAP_MS);
    }
    this.setStep("Restoring the clipboard…", cx);
    if (type) exec("sh", ["-c", RESTORE_SH, "sh", saved, type]).catch(() => null);
    else exec("rm", ["-f", saved]).catch(() => null);
  }

  async tempFile() {
    const r = await exec("mktemp", ["-t", "herdr-attach-clip.XXXXXX"]).catch(() => null);
    return r?.stdout.trim() || "/tmp/herdr-attach-clip";
  }

  button(t, id, label, onClick, strong = false) {
    return div()
      .id(id)
      .px(strong ? 12 : 6)
      .py(strong ? 4 : 1)
      .rounded(5)
      .flex_none()
      .text_size(strong ? 12 : 11)
      .text_color(strong ? t.foreground : t.muted)
      .when(strong, (el) => el.bg(t.raised ?? t.hover).border_1().border_color(t.border))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      // A press that isn't stopped drags the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  header(t) {
    const overlay = props()?.overlay;
    return h_flex().h(32).flex_none().px(10).gap(6).items_center().text_size(12).border_b(1).border_color(t.border)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Add files"))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child("into an agent's input, unsent"))
      .when(Boolean(overlay), (el) => el.child(this.button(t, "close", "✕", () => closeOverlay(overlay))));
  }

  agentRows(t) {
    const list = this.agentList();
    const chosen = this.target();
    if (!list.length) return [div().px(10).py(4).text_size(11).text_color(t.dim).child("No agents are running.")];
    return list.map((a) => {
      const on = a.address === chosen?.address;
      const machine = this.machineOf(a);
      return h_flex().id(`agent-${a.address}`).mx(6).px(6).py(3).gap(8).items_center().rounded(5)
        .cursor_pointer().text_size(11.5)
        .when(on, (el) => el.bg(t.raised ?? t.hover))
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.chosen = a.address; cx.notify(); })
        .child(div().flex_none().w(10).text_color(t.accent).child(on ? "●" : ""))
        .child(div().flex_none().text_color(t.foreground).child(a.program?.name ?? "agent"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${a.space_name} / ${a.tab_name} · ${a.title || a.status}`))
        .when(Boolean(machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.accent).child(machine)));
    });
  }

  fileRows(t) {
    if (!this.files.length) {
      return [v_flex().mx(10).my(4).py(18).gap(4).items_center().rounded(8).border_1().border_dashed().border_color(t.border)
        .child(div().text_size(12).text_color(t.muted).child("Drop files here"))
        .child(div().text_size(10.5).text_color(t.dim).child("or press Choose… · images arrive as [Image #1]"))];
    }
    return this.files.map((f) => h_flex().id(`file-${f.path}`).mx(6).px(6).py(2).gap(8).items_center().rounded(5).text_size(11.5)
      .hover((s) => s.bg(t.hover))
      .child(div().flex_none().w(44).text_size(10).text_color(f.kind === "x" ? t.blocked : t.dim)
        .child(f.kind === "d" ? "folder" : f.kind === "x" ? "gone" : IMAGE.test(f.name) ? "image" : "file"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(f.name))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(f.kind === "f" ? sizeText(f.size) : ""))
      .child(this.button(t, `rm-${f.path}`, "✕", (_e, cx) => this.remove(f.path, cx))));
  }

  sectionTitle(t, text) {
    return div().flex_none().mx(6).mt(8).mb(2).px(10).py(4).rounded(5).bg(t.raised ?? t.hover)
      .text_size(11).font_semibold().text_color(t.foreground).child(text);
  }

  render(_props, cx) {
    const t = theme();
    const agent = this.target();
    const ready = Boolean(agent && this.files.length && !this.busy);
    const label = this.busy ? (this.step ?? "Adding…") : agent ? `Add to ${agent.program?.name ?? "agent"}` : "No agent";
    return v_flex()
      .id("attach")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
        else if (e.key === "enter" && ready) { this.send(cx); cx.stop_propagation(); }
      })
      .on_drop((e, cx) => this.add(e.paths ?? [], cx))
      .size_full()
      .text_size(13)
      .child(this.header(t))
      .child(this.sectionTitle(t, "Agent"))
      .child(v_flex().id("agents").flex_none().max_h(150).overflow_y_scrollbar().children(this.agentRows(t)))
      .child(this.sectionTitle(t, this.files.length ? `Files (${this.files.length})` : "Files"))
      .child(v_flex().id("files").flex_1().min_h(0).overflow_y_scrollbar().children(this.fileRows(t)))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().px(10).py(4).text_size(10.5)
        .text_color(this.note.bad ? t.blocked : t.dim).child(this.note.text)))
      .child(h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border)
        .child(this.button(t, "pick", "Choose…", (_e, cx) => this.pick(cx), true))
        .when(this.files.length > 0, (el) => el.child(this.button(t, "clear", "Clear", (_e, cx) => { this.files = []; cx.notify(); })))
        .child(div().flex_1())
        .child(ready
          ? this.button(t, "send", label, (_e, cx) => this.send(cx), true)
          : div().flex_none().px(12).py(4).text_size(12).text_color(t.dim).child(label)));
  }
}

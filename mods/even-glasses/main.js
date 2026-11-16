// Even Glasses: Herdr's agents on Even Realities G2 glasses.
//
// Opened as a dialog (`mod.open {name: "even-glasses"}`) this is the settings
// page: run and pair the bridge, choose how agents show on the glasses. In a
// layout block with props `{ "row": true }` it is the sidebar row that opens
// that page, and the copy that starts the bridge with Herdr.
//
// The bridge (bridge.mjs, beside this file) is what the Even app talks to. It
// runs in an hc terminal named "even-glasses", so it outlives this window.
// Settings live in <herdr-app home>/even-glasses.json; both sides read it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, Popup } from "gpui-base";
import { exec, hc, run, theme, agents, props, closeOverlay, notify, appHome, readTextFile, writeTextFile, knownAgents, checking, layout } from "herdr";

const MOD = "mods/even-glasses";
const TERMINAL = "even-glasses";
const NETWORKS = [
  ["lan", "Wi-Fi"],
  ["tailscale", "Tailscale"],
  ["loopback", "This Mac only"],
];
const PROVIDERS = [
  ["claude", "Claude"],
  ["codex", "Codex"],
];

const bridgeFile = () => `${appHome()}/${MOD}/bridge.mjs`;
const message = (e) => String(e?.message ?? e);

// Version managers (nvm, fnm) only put node on the PATH of an interactive shell, so ask one.
let nodeAt = null;
async function nodePath() {
  if (nodeAt) return nodeAt;
  const lookups = [["which", ["node"]], ["sh", ["-c", '"${SHELL:-/bin/sh}" -ilc "command -v node" 2>/dev/null']]];
  for (const [command, args] of lookups) {
    const found = (await exec(command, args)).stdout.trim().split("\n").filter((line) => line.startsWith("/")).pop();
    if (found) return (nodeAt = found);
  }
  throw new Error("Node.js was not found. The bridge needs Node 18 or newer.");
}

// `info` makes the settings file the first time; `rotate` replaces the pairing token.
async function bridge(command) {
  const r = await exec(await nodePath(), [bridgeFile(), command]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `bridge ${command} failed`);
  return JSON.parse(r.stdout);
}

// What the running bridge says about itself, or null when nothing answers.
async function health(config) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/bridge`, { headers: { authorization: `Bearer ${config.token}` } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function startBridge(config) {
  if (await health(config)) return;
  await hc(["rm", TERMINAL]); // a finished one from last time; fails harmlessly when there is none
  const started = await hc(["run", "--bg", "--no-parent", "--name", TERMINAL, "--", await nodePath(), bridgeFile(), "serve"]);
  if (started.code !== 0) throw new Error(started.stderr.trim() || "herdr-core could not start the bridge.");
  // No timers for a one-off: a one-second `hc wait` is the pause, and it ends at once if the bridge exits.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await health(config)) return;
    await hc(["wait", TERMINAL, "--timeout", "1"]);
  }
  const log = (await hc(["read", TERMINAL, "--lines", "20"])).stdout.trim().split("\n");
  throw new Error(log.filter((line) => line.startsWith("error:")).pop() ?? log.pop() ?? "The bridge did not start.");
}

async function stopBridge() {
  await hc(["kill", TERMINAL]);
  await hc(["rm", TERMINAL]);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class EvenGlasses extends View {
  init(_props, cx) {
    this.row = Boolean(props()?.row);
    this.info = null; // { config, address, problem, url, qr, file }
    this.health = null;
    this.busy = null; // "Starting…" | "Stopping…" while the bridge changes
    this.error = null;
    this.showCode = false;
    this.menu = null; // id of the dropdown whose list is open
    this.programs = [];
    this.focused = {};
    if (!this.row) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.inputs = { name: this.field("name", cx), port: this.field("port", cx) };
    }
    if (checking()) return; // a check must not start programs or write files
    cx.spawn(async (cx) => {
      try {
        this.info = await bridge("info");
        this.health = await health(this.info.config);
        if (this.row && this.info.config.autostart && !this.health) {
          await startBridge(this.info.config);
          this.health = await health(this.info.config);
        }
        if (!this.row) {
          this.fill();
          this.programs = (await knownAgents()).filter((p) => p.installed && p.run.length === 1);
        }
      } catch (e) {
        this.error = message(e);
        if (this.row) notify({ title: "Even Glasses bridge did not start", body: this.error, level: "error" });
      }
      cx.notify();
    });
    cx.timer.every(this.row ? 5000 : 2000, (cx) => {
      if (!this.info || this.busy) return;
      cx.spawn(async (cx) => {
        // The other copy may have changed the settings or the bridge.
        if (this.row) this.info = await bridge("info");
        const next = await health(this.info.config);
        if (JSON.stringify(next) === JSON.stringify(this.health)) return;
        this.health = next;
        cx.notify();
      });
    });
  }

  // A text setting: saved when you press Enter or leave the field.
  field(key, cx) {
    const state = InputState.new();
    const commit = (_e, cx) => this.commit(key, cx);
    state.on("submit", commit);
    state.on("focus", (_e, cx) => { this.focused[key] = true; cx.notify(); });
    state.on("blur", (e, cx) => { this.focused[key] = false; commit(e, cx); });
    return state;
  }

  fill() {
    this.inputs.name.set_value(String(this.info.config.name ?? ""));
    this.inputs.port.set_value(String(this.info.config.port));
  }

  commit(key, cx) {
    if (!this.info) return;
    const text = this.inputs[key].value().trim();
    let value = text;
    if (key === "port") {
      value = Number(text);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) {
        notify({ title: "Port must be a number from 1024 to 65535", level: "error" });
        return this.fill();
      }
    }
    if (value !== this.info.config[key]) this.change((c) => { c[key] = value; }, cx);
  }

  // Writes the settings file the way Settings writes settings.json: read,
  // change, write back only if nobody changed it meanwhile. A running bridge
  // picks most of it up by itself; a new port or network needs a restart.
  change(edit, cx) {
    cx.spawn(async (cx) => {
      try {
        const before = this.info.config;
        const raw = await readTextFile(this.info.file);
        const next = JSON.parse(raw);
        edit(next);
        const moved = next.port !== before.port || next.network !== before.network;
        const running = Boolean(this.health);
        if (moved && running) await stopBridge();
        await writeTextFile(this.info.file, JSON.stringify(next, null, 2) + "\n", raw);
        this.info = await bridge("info");
        if (moved && running) await startBridge(this.info.config);
        this.health = await health(this.info.config);
        this.error = null;
      } catch (e) {
        this.error = message(e);
        notify({ title: "Even Glasses", body: this.error, level: "error" });
      }
      this.fill();
      cx.notify();
    });
  }

  power(cx) {
    const on = Boolean(this.health);
    this.busy = on ? "Stopping…" : "Starting…";
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (on) await stopBridge();
        else await startBridge(this.info.config);
      } catch (e) {
        this.error = message(e);
      }
      this.health = await health(this.info.config);
      this.busy = null;
      cx.notify();
    });
  }

  rotate(cx) {
    cx.spawn(async (cx) => {
      try {
        this.info = await bridge("rotate");
        notify({ title: "New pairing token", body: "Scan the new code in the Even app to pair again." });
      } catch (e) {
        notify({ title: "Token not changed", body: message(e), level: "error" });
      }
      cx.notify();
    });
  }

  // Pieces, drawn like Herdr's own Settings -----------------------------

  heading(t, text) {
    return div().pt(18).pb(8).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  setting(t, title, about, control) {
    return h_flex().w_full().gap(16).py(12).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).text_color(t.foreground).child(title))
        .when(Boolean(about), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about))))
      .child(div().flex_none().child(control));
  }

  button(t, id, label, onClick) {
    return div().id(id).px(12).py(5).rounded(7).border_1().border_color(t.border).bg(t.raised).cursor_pointer()
      .text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  toggle(t, id, on, onClick) {
    return div().id(id).w(36).h(20).rounded(10).p(2).cursor_pointer().bg(on ? t.accent : t.hover).flex()
      .when(on, (el) => el.justify_end()).on_click(onClick)
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  // One of a few: [[value, label], …].
  choice(t, id, options, value, onPick) {
    return h_flex().flex_wrap().justify_end().max_w(340).gap(4).children(
      options.map(([v, label]) => {
        const on = v === value;
        return div().id(`${id}-${v || "off"}`).px(10).py(5).rounded(7).border_1().cursor_pointer().text_size(13)
          .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { if (!on) onPick(v, cx); }).child(label);
      }));
  }

  closeMenu(cx) {
    this.menu = null;
    this.handle.focus();
    cx.notify();
  }

  // One of many: the current choice on a button, the rest in a list under it.
  dropdown(t, id, options, value, onPick) {
    const open = this.menu === id;
    const current = options.find(([v]) => v === value)?.[1] ?? value;
    const trigger = h_flex().id(id).w(200).px(12).py(6).gap(8).items_center().rounded(7).border_1().cursor_pointer()
      .border_color(open ? t.accent : t.border).bg(t.raised).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (open) this.closeMenu(cx); else { this.menu = id; cx.notify(); } })
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(current))
      .child(svg(`${MOD}/chevron-down.svg`).flex_none().size(14).text_color(t.dim));
    const list = v_flex().id(`${id}-list`).w(200).mt(4).p(4).rounded(8).border_1().border_color(t.border).bg(t.background)
      .on_mouse_down_out((_e, cx) => this.closeMenu(cx))
      .children(options.map(([v, label]) => {
        const on = v === value;
        return h_flex().id(`${id}-${v || "off"}`).px(8).py(5).gap(8).items_center().rounded(6).cursor_pointer()
          .bg(on ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.closeMenu(cx); if (!on) onPick(v, cx); })
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(on ? t.foreground : t.muted).child(label))
          .when(on, (el) => el.child(svg(`${MOD}/check.svg`).flex_none().size(13).text_color(t.accent)));
      }));
    return Popup.new(`${id}-popup`, trigger).when(open, (el) => el.content(list));
  }

  stepper(t, id, value, onMinus, onPlus) {
    const b = (k, label, f) => div().id(`${id}-${k}`).w(28).h(28).flex().items_center().justify_center().cursor_pointer()
      .text_size(15).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(f).child(label);
    return h_flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
      .child(b("minus", "\u2212", onMinus))
      .child(div().w(54).text_size(13).text_color(t.foreground).flex().justify_center().child(String(value)))
      .child(b("plus", "+", onPlus));
  }

  text(t, key, width) {
    return Input.new(this.inputs[key]).w(width).h(30).px(10).rounded(7).border_1()
      .border_color(this.focused[key] ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground);
  }

  // The pairing QR as plain rectangles: one per run of same-colored cells.
  code(rows) {
    const cell = Math.max(2, Math.floor(180 / rows.length));
    return v_flex().flex_none().p(cell * 3).rounded(8).bg("#ffffff").children(
      rows.map((row) => h_flex().children((row.match(/1+|0+/g) ?? []).map((cells) =>
        div().w(cells.length * cell).h(cell).bg(cells[0] === "1" ? "#000000" : "#ffffff")))));
  }

  // Sections ------------------------------------------------------------

  status(t) {
    const { address, problem, config } = this.info;
    const up = this.health;
    const mounted = up?.mounted ?? [];
    const line = this.busy ?? (up ? `Running at ${up.address}:${up.port}` : "Stopped");
    const detail = this.error ?? problem ?? (up
      ? `${up.agents} ${up.agents === 1 ? "agent" : "agents"} listed. ${mounted.length ? `Glasses are on ${mounted.join(", ")}.` : "No glasses connected."}`
      : `Start it, then pair the Even app with ${address ?? "this Mac"}:${config.port}.`);
    return h_flex().w_full().gap(14).p(14).items_center().rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(div().flex_none().w(9).h(9).rounded(5).bg(this.error || problem ? t.blocked : up ? t.done : t.dim))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(line))
        .child(div().text_size(12.5).line_height("18px").text_color(this.error || problem ? t.blocked : t.dim).child(detail)))
      .child(this.button(t, "eg-power", up ? "Stop" : "Start", (_e, cx) => { if (!this.busy) this.power(cx); }));
  }

  pairing(t) {
    const { url, qr, config } = this.info;
    const masked = `${config.token.slice(0, 4)}\u2026${config.token.slice(-4)}`;
    return v_flex()
      .child(this.heading(t, "Pair"))
      .child(this.setting(t, "Pairing code",
        url ? "In the Even app, add a terminal and scan this code. It holds the address and the token, so only show it when nobody else can see your screen." : "No address to pair with yet: see the network setting below.",
        h_flex().gap(8)
          .when(Boolean(url), (el) => el.child(this.button(t, "eg-copy", "Copy link", (_e, cx) => { cx.write_to_clipboard(url); notify({ title: "Pairing link copied" }); })))
          .when(Boolean(url && qr), (el) => el.child(this.button(t, "eg-code", this.showCode ? "Hide code" : "Show code", (_e, cx) => { this.showCode = !this.showCode; cx.notify(); })))))
      .when(Boolean(this.showCode && qr), (el) => el.child(h_flex().py(14).justify_center().border_b(1).border_color(t.border).child(this.code(qr))))
      .child(this.setting(t, "Token", `${masked}. A new token unpairs every phone until it scans the new code.`,
        this.button(t, "eg-rotate", "New token", (_e, cx) => this.rotate(cx))));
  }

  connection(t) {
    const c = this.info.config;
    return v_flex()
      .child(this.heading(t, "Connection"))
      .child(this.setting(t, "Start with Herdr", "Run the bridge whenever Herdr opens. It keeps running when the window closes.",
        this.toggle(t, "eg-autostart", c.autostart, (_e, cx) => this.change((n) => { n.autostart = !n.autostart; }, cx))))
      .child(this.setting(t, "Network", "How the phone reaches this Mac: the same Wi-Fi, or Tailscale from anywhere.",
        this.choice(t, "eg-net", NETWORKS, c.network, (v, cx) => this.change((n) => { n.network = v; }, cx))))
      .child(this.setting(t, "Port", "Even Terminal uses 3456; keep this one different to run both.", this.text(t, "port", 90)))
      .child(this.setting(t, "Name", "What the Even app calls this Mac.", this.text(t, "name", 180)));
  }

  glasses(t) {
    const c = this.info.config;
    const starters = [["", "Off"], ...this.programs.map((p) => [p.run[0], p.name])];
    if (c.new_agent && !starters.some(([v]) => v === c.new_agent)) starters.push([c.new_agent, c.new_agent]);
    return v_flex()
      .child(this.heading(t, "On the glasses"))
      .child(this.setting(t, "List agents under", "The Even app has a Claude list and a Codex list. Every Herdr agent shows in this one, whatever it runs.",
        this.choice(t, "eg-prov", PROVIDERS, c.provider, (v, cx) => this.change((n) => { n.provider = v; }, cx))))
      .child(this.setting(t, "Stream while working", "Show an agent's new lines as they appear. Off: only what is on its screen when the turn ends.",
        this.toggle(t, "eg-stream", c.stream, (_e, cx) => this.change((n) => { n.stream = !n.stream; }, cx))))
      .child(this.setting(t, "Answer from the glasses", "When an agent waits on a yes or no, ask on the glasses: Yes presses Enter in its terminal, No presses Esc.",
        this.toggle(t, "eg-answer", c.answer, (_e, cx) => this.change((n) => { n.answer = !n.answer; }, cx))))
      .child(this.setting(t, "New agent from the glasses", "A prompt sent with no agent selected opens a new tab running this.",
        this.dropdown(t, "eg-new", starters, c.new_agent, (v, cx) => this.change((n) => { n.new_agent = v; }, cx))))
      .child(this.setting(t, "Lines when mounting", "How much of an agent's screen the glasses get when you select it.",
        this.stepper(t, "eg-lines", c.history_lines,
          (_e, cx) => this.change((n) => { n.history_lines = Math.max(10, n.history_lines - 10); }, cx),
          (_e, cx) => this.change((n) => { n.history_lines = Math.min(200, n.history_lines + 10); }, cx))));
  }

  // What the glasses list right now.
  active(t) {
    const mounted = this.health?.mounted ?? [];
    const all = agents();
    return v_flex()
      .child(this.heading(t, "Active agents"))
      .when(all.length === 0, (el) => el.child(div().py(10).text_size(13).text_color(t.dim).child("No agents are running. Start one in a tab and it shows up on the glasses.")))
      .children(all.map((a) => h_flex().id(`eg-a-${a.address}`).gap(10).py(8).items_center().border_b(1).border_color(t.border).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => run("agent.focus", { terminal: a.address }))
        .child(div().flex_none().w(8).h(8).rounded(4).bg(t[a.status] ?? t.idle))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(t.foreground).child(`${a.space_name} / ${a.tab_name}`))
        .child(div().flex_none().text_size(12.5).text_color(t.dim).child(a.program?.name ?? a.app ?? "agent"))
        .when(mounted.includes(a.address), (el) => el.child(div().flex_none().px(7).py(2).rounded(6).bg(t.accent).text_size(11.5).text_color(t.accent_foreground).child("on glasses")))));
  }

  sidebarRow(t) {
    const collapsed = (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    const mounted = (this.health?.mounted ?? []).length > 0;
    const dot = div().flex_none().size(6).rounded_full().bg(mounted ? t.working : t.done);
    return v_flex().size_full().bg(t.chrome).px(8).justify_center().text_size(13).when(collapsed, (el) => el.px(0).items_center())
      .child(h_flex().id("eg-open").h(28).px(8).gap(9).items_center().rounded(8).cursor_pointer()
        .when(collapsed, (el) => el.relative().w(32).px(0).justify_center().tooltip("Even Glasses"))
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("mod.open", { name: "even-glasses" }))
        .child(svg(`${MOD}/glasses.svg`).size(14))
        .when(!collapsed, (el) => el.child(div().flex_1().child("Even Glasses")))
        .when(Boolean(this.health), (el) => el.child(collapsed ? dot.absolute().top(5).right(6) : dot)));
  }

  render() {
    const t = theme();
    if (this.row) return this.sidebarRow(t);
    return v_flex().id("even-glasses").track_focus(this.handle).w_full().h(640).min_h(0)
      // Esc closes the top dialog; with a list open it closes the list instead.
      .when(Boolean(this.menu), (el) => el.on_action("overlay.close", (_e, cx) => {
        this.closeMenu(cx);
        cx.stop_propagation();
      }))
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.menu) this.closeMenu(cx);
        else closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .child(h_flex().flex_none().gap(12).px(28).pt(20).pb(14).items_center().border_b(1).border_color(t.border)
        .child(svg(`${MOD}/glasses.svg`).size(20).text_color(t.accent))
        .child(v_flex().flex_1().gap(2)
          .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Even Glasses"))
          .child(div().text_size(12.5).text_color(t.dim).child("See your Herdr agents on Even Realities G2: pick one on the glasses to mount it."))))
      .child(div().relative().flex_1().min_h(0).w_full()
        .child(div().id("eg-body").size_full().overflow_y_scroll().child(
          !this.info
            ? div().px(28).py(22).text_size(13).text_color(this.error ? t.blocked : t.dim).child(this.error ?? "Loading\u2026")
            : v_flex().px(28).pt(18).pb(22)
              .child(this.status(t))
              .child(this.pairing(t))
              .child(this.connection(t))
              .child(this.glasses(t))
              .child(this.active(t))))
        .child(Scrollbar.vertical("eg-body").mode("always").absolute().inset_0()));
  }
}

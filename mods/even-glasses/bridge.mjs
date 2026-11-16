#!/usr/bin/env node
// Even Glasses bridge: shows Herdr's active agents on Even Realities G2 glasses.
//
// The Even app talks to a small HTTP API (the one `even-terminal` serves): it
// lists sessions, mounts one (history + a stream of events) and sends prompts
// back. This server answers that API from herdr-core (`hc`), so every live
// agent is a session: pick one on the glasses to mount it, its screen streams
// to the display, and what you say or tap is typed into its terminal.
//
//   node bridge.mjs            serve
//   node bridge.mjs info       make the config if missing; print it with the pairing URL and QR
//   node bridge.mjs rotate     new pairing token, then the same as info
//
// No dependencies. Settings: <herdr-app home>/even-glasses.json, written by
// the Even Glasses dialog (mods/even-glasses/main.js).

import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";

const VERSION = "1";
// Started by Herdr there is no shell PATH: add where node (and even-terminal), hc and herdr-app live.
process.env.PATH = [dirname(process.execPath), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":");
const APP_HOME = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const CONFIG_FILE = join(APP_HOME, "even-glasses.json");
// The Even app only knows these provider names; agents are listed under one of them.
const PROVIDERS = ["claude", "claude-sync", "codex"];
const DEFAULTS = {
  autostart: false,
  port: 3457,
  network: "lan", // lan | tailscale | loopback
  name: "Herdr",
  provider: "claude",
  token: "",
  stream: true, // send the agent's screen as it changes, not only when a turn ends
  answer: true, // let the glasses answer an agent that is waiting on a yes/no
  new_agent: "omo", // program a prompt with no mounted agent starts in a new tab; "" refuses
  history_lines: 40,
  poll_ms: 1000,
};

// ── Settings ───────────────────────────────────────────

let cached = { mtime: -1, config: { ...DEFAULTS } };

function readConfig() {
  let mtime;
  try {
    mtime = statSync(CONFIG_FILE).mtimeMs;
  } catch {
    return { ...DEFAULTS };
  }
  if (mtime !== cached.mtime) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      cached = { mtime, config: { ...DEFAULTS, ...parsed } };
    } catch (err) {
      // Mid-edit: keep serving with the last good settings.
      console.error(`[config] ${CONFIG_FILE} is not valid JSON, keeping the last good settings: ${err.message}`);
      cached.mtime = mtime;
    }
  }
  return cached.config;
}

function writeConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600); // it holds the pairing token
}

/** The settings, created with a fresh token the first time (or with `rotate`). */
function ensureConfig(rotate = false) {
  const config = readConfig();
  if (rotate || !config.token) writeConfig({ ...config, token: randomBytes(16).toString("hex") });
  else chmodSync(CONFIG_FILE, 0o600); // the dialog rewrites the file, which can loosen it
  return readConfig();
}

// ── Network and pairing ────────────────────────────────

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(iface.address)) return iface.address;
    }
  }
  return null;
}

function tailscaleAddress() {
  try {
    return execFileSync("tailscale", ["ip", "-4"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

/** The address the phone reaches, or why there is none. */
function reach(config) {
  if (config.network === "loopback") return { address: "127.0.0.1", problem: null };
  if (config.network === "tailscale") {
    const address = tailscaleAddress();
    return { address, problem: address ? null : "No Tailscale IPv4 address: is Tailscale installed and signed in?" };
  }
  const address = lanAddress();
  return { address, problem: address ? null : "No private Wi-Fi or Ethernet address found." };
}

function pairingUrl(config, address) {
  const query = new URLSearchParams({ token: config.token, defaultProvider: config.provider });
  if (config.name) query.set("name", config.name);
  return `http://${address}:${config.port}?${query}`;
}

/** The QR for `text` as rows of "1"/"0", from the encoder even-terminal ships; null without it. */
function qrMatrix(text) {
  try {
    const bin = process.env.PATH.split(":").map((dir) => join(dir, "even-terminal")).find((file) => existsSync(file));
    const root = dirname(dirname(realpathSync(bin)));
    const need = createRequire(join(root, "package.json"));
    const QRCode = need("qrcode-terminal/vendor/QRCode");
    const level = need("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
    const qr = new QRCode(-1, level.L);
    qr.addData(text);
    qr.make();
    return qr.modules.map((row) => row.map((on) => (on ? "1" : "0")).join(""));
  } catch {
    return null;
  }
}

function info(config) {
  const { address, problem } = reach(config);
  const url = address ? pairingUrl(config, address) : null;
  return { version: VERSION, file: CONFIG_FILE, config, address, problem, url, qr: url ? qrMatrix(url) : null };
}

// ── herdr-core ─────────────────────────────────────────

// Without HC_TERMINAL_ID: with it, hc treats us as a terminal and wraps what
// we send in <hc from=…> notes, which agents read as chat from another agent.
const ENV = { ...process.env };
delete ENV.HC_TERMINAL_ID;

function call(command, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: ENV, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split("\n")[0]));
      else resolve(stdout);
    });
  });
}

const STATE = { working: "busy", blocked: "awaiting" };

/** Every live terminal whose program reports a status: that is what makes it an agent (hc names any program's `agent`). */
async function listAgents() {
  const out = JSON.parse(await call("hc", ["ls", "--json"]));
  return (out.terminals ?? [])
    .filter((t) => t.status && t.state === "live")
    .map((t) => ({
      id: t.address,
      agent: t.agent ?? "agent",
      cwd: t.cwd ?? "",
      where: t.where ?? t.name ?? "",
      status: t.status ?? "idle",
      state: STATE[t.status] ?? "idle",
    }));
}

async function findAgent(id) {
  return (await listAgents()).find((a) => a.id === id) ?? null;
}

/** A terminal's text as trimmed, non-empty lines (the screen, plus `history` lines above it). */
async function readLines(id, history = 0) {
  const out = JSON.parse(await call("hc", ["read", "--json", "--lines", String(history), id]));
  return String(out.text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
}

// ── Sessions: one per mounted agent ────────────────────

const MAX_MESSAGES = 500;
const MAX_SEEN = 3000;
const LINGER_MS = 30000; // keep watching this long after the last client or request
const sessions = new Map();

function session(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { messages: [], clients: new Set(), nextId: 1, touched: 0, seen: new Map(), primed: false, state: null, turnStart: 0, decision: null, lines: [] };
    sessions.set(id, s);
  }
  s.touched = Date.now();
  return s;
}

function emit(id, msg) {
  const s = session(id);
  const entry = { id: s.nextId++, msg };
  s.messages.push(entry);
  if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
  const data = `id: ${entry.id}\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of s.clients) {
    try {
      res.write(data);
    } catch {
      s.clients.delete(res);
    }
  }
}

// A screen redraws in place: spinners turn, timers and token counts tick. Those
// are blanked before comparing, so a status line that only counts up is not
// new each second, while "step 2" after "step 1" still is.
const TICKING = /\d+:\d+(:\d+)?|\d+(\.\d+)?\s?(ms|s|m|h|%|k|K|M|tokens?)(?![\p{L}\p{N}])/gu;
const lineKey = (line) => line.replace(/[\u2800-\u28ff\u25d0-\u25d3\u25f4-\u25f7]/g, "").replace(TICKING, "#").replace(/\s+/g, " ").trim();
const hasWords = (line) => /[\p{L}\p{N}]/u.test(line);

function freshLines(s, lines) {
  const fresh = [];
  for (const line of lines) {
    if (!hasWords(line)) continue;
    const key = lineKey(line);
    if (s.seen.has(key)) continue;
    s.seen.set(key, true);
    fresh.push(line);
  }
  if (s.seen.size > MAX_SEEN) {
    for (const key of [...s.seen.keys()].slice(0, s.seen.size - MAX_SEEN / 2)) s.seen.delete(key);
  }
  return fresh;
}

const tail = (lines, n) => lines.slice(-n).join("\n");

/** Turns one look at a mounted agent into the events the Even app understands. */
function advance(id, s, agent, lines, config) {
  const provider = config.provider;
  const before = s.state;
  const fresh = freshLines(s, lines);
  s.lines = lines;
  s.state = agent.state;

  if (!s.primed) {
    // First look: history already showed this screen, so only the state goes out.
    s.primed = true;
    if (agent.state === "busy") {
      s.turnStart = Date.now();
      emit(id, { type: "status", state: "busy", sessionId: id, provider });
    }
  } else {
    if (agent.state === "busy" && before !== "busy") {
      if (before !== "awaiting") s.turnStart = Date.now();
      emit(id, { type: "status", state: "busy", sessionId: id, provider });
    }
    if (config.stream && fresh.length) emit(id, { type: "text_delta", text: fresh.join("\n") + "\n" });
  }

  if (agent.state === "awaiting" && before !== "awaiting") {
    const asked = tail(lines, 6);
    if (config.answer) {
      emit(id, {
        type: "permission_request",
        toolName: agent.agent,
        description: `${agent.agent} is waiting for you`,
        detail: asked.slice(0, 400),
        toolUseId: `${id}-${Date.now()}`,
        options: [{ text: "Yes", key: "allow" }, { text: "No", key: "deny" }],
        suggestions: null,
      });
    } else {
      emit(id, { type: "notification", title: `${agent.agent} is waiting for you`, message: asked.slice(0, 400) });
    }
  }
  if (before === "awaiting" && agent.state !== "awaiting" && s.decision) {
    emit(id, { type: "permission_result", toolName: agent.agent, summary: `${agent.agent} was waiting for you`, decision: s.decision });
    s.decision = null;
  }
  if (agent.state === "idle" && (before === "busy" || before === "awaiting")) {
    emit(id, {
      type: "result",
      success: agent.status !== "error",
      // Streaming already showed the turn; without it this is the whole answer.
      text: config.stream ? "" : tail(lines, config.history_lines),
      sessionId: id,
      costUsd: 0,
      provider,
      turns: 1,
      durationMs: s.turnStart ? Date.now() - s.turnStart : 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    emit(id, { type: "status", state: "idle", sessionId: id, provider });
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  const watched = [...sessions].filter(([, s]) => s.clients.size > 0 || Date.now() - s.touched < LINGER_MS);
  if (!watched.length) return;
  ticking = true;
  try {
    const config = readConfig();
    const agents = new Map((await listAgents()).map((a) => [a.id, a]));
    await Promise.all(
      watched.map(async ([id, s]) => {
        const agent = agents.get(id);
        if (!agent) {
          if (s.state !== "gone") {
            s.state = "gone";
            emit(id, { type: "error", message: "This agent has ended." });
            emit(id, { type: "status", state: "idle", sessionId: id, provider: config.provider });
          }
          return;
        }
        try {
          advance(id, s, agent, await readLines(id), config);
        } catch (err) {
          console.error(`[watch] ${id}: ${err.message}`);
        }
      }),
    );
  } catch (err) {
    console.error(`[watch] ${err.message}`);
  } finally {
    ticking = false;
  }
}

// ── HTTP ───────────────────────────────────────────────

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function authorized(req, url, config) {
  const header = req.headers.authorization;
  const given = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!given || !config.token) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 1024 * 1024) reject(Object.assign(new Error("Request body too large"), { status: 413 }));
    });
    req.on("end", () => {
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("Request body is not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const sameProvider = (asked, config) => !asked || asked.replace("-sync", "") === config.provider.replace("-sync", "");
const title = (a) => `${a.status === "blocked" ? "! " : ""}${a.where || basename(a.cwd) || a.id} · ${a.agent}`.slice(0, 64);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function mounted(id) {
  if (!id) throw fail(400, "Missing 'sessionId'");
  const agent = await findAgent(id);
  if (!agent) throw fail(404, "Session not found");
  return agent;
}

const routes = {
  // What the dialog shows: is it up, who is connected, which agents are mounted.
  "GET /api/bridge": async (_req, _url, config) => ({
    ok: true,
    version: VERSION,
    port: config.port,
    address: reach(config).address,
    agents: (await listAgents()).length,
    clients: [...sessions.values()].reduce((n, s) => n + s.clients.size, 0),
    mounted: [...sessions].filter(([, s]) => s.clients.size > 0).map(([id]) => id),
  }),

  "GET /api/info": async (_req, _url, config) => {
    const version = (await call("hc", ["--version"]).catch(() => "")).trim();
    return { account: { email: "", organization: "Herdr", subscriptionType: "" }, model: "Herdr agents", version: version || "Unknown", provider: config.provider, extra: { expose: "off" } };
  },

  "GET /api/update-check": async () => ({ packageName: "herdr-even-glasses", currentVersion: VERSION, newestVersion: null, updateAvailable: false, checkedAt: new Date().toISOString() }),

  "GET /api/metrics": async () => ({ codex: { subscribedSessions: [] } }),

  // The list on the glasses: every active agent, the ones needing you or working first.
  "GET /api/sessions": async (_req, url, config) => {
    if (!sameProvider(url.searchParams.get("provider"), config)) return { sessions: [] };
    const limit = Number(url.searchParams.get("limit")) || 10;
    const order = { blocked: 0, working: 1 };
    const agents = (await listAgents()).sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
    const now = Date.now();
    return {
      sessions: agents.slice(0, limit).map((a, i) => ({ id: a.id, title: title(a), timestamp: new Date(now - i * 1000).toISOString(), cwd: a.cwd, provider: config.provider, status: a.state })),
    };
  },

  "GET /api/status": async (_req, url, config) => {
    const agent = await mounted(url.searchParams.get("sessionId"));
    session(agent.id);
    return { state: agent.state, sessionId: agent.id, provider: config.provider };
  },

  "GET /api/messages": async (_req, url, config) => {
    const id = url.searchParams.get("sessionId");
    if (!id) throw fail(400, "Missing 'sessionId'");
    const after = parseInt(url.searchParams.get("after"), 10) || 0;
    const s = session(id);
    return { messages: s.messages.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg })), state: s.state && s.state !== "gone" ? s.state : "idle", sessionId: id, provider: config.provider };
  },

  // Typed into the mounted agent; with none mounted, starts one in a new Herdr tab.
  "POST /api/prompt": async (req, _url, config) => {
    const { text, sessionId } = await body(req);
    if (!text || typeof text !== "string") throw fail(400, "Missing 'text' field");
    let id = sessionId;
    if (id) {
      await mounted(id);
      // Waits out a draft someone is typing there, so don't hold the reply for it.
      call("hc", ["send", id, text], 90000).catch((err) => emit(id, { type: "error", message: `Not sent: ${err.message}` }));
    } else {
      if (!config.new_agent) throw fail(400, "Pick an agent first: starting new agents from the glasses is off.");
      const made = JSON.parse(await call("herdr-app", ["do", "tab.new", "--name", "Glasses", "--argv", JSON.stringify([config.new_agent]), "--task", text]));
      if (!made.terminal) throw fail(500, made.error ?? "Herdr did not start the agent");
      id = made.terminal;
    }
    emit(id, { type: "user_prompt", text });
    return { status: 202, ok: true, sessionId: id, provider: config.provider };
  },

  "POST /api/interrupt": async (req) => {
    const agent = await mounted((await body(req)).sessionId);
    await call("hc", ["interrupt", agent.id]);
    return { ok: true };
  },

  // Yes is Enter (the highlighted choice), No is Esc: what agents' own dialogs take.
  "POST /api/permission-response": async (req, _url, config) => {
    const { sessionId, decision } = await body(req);
    const agent = await mounted(sessionId);
    if (!config.answer) throw fail(400, "Answering agents from the glasses is off.");
    if (agent.state !== "awaiting" || !["allow", "deny"].includes(decision ?? "deny")) throw fail(400, "Permission decision was not offered or no permission request is pending");
    const allow = decision === "allow";
    await call("hc", ["keys", agent.id, allow ? "enter" : "esc"]);
    session(agent.id).decision = allow ? "allowed" : "denied";
    return { ok: true };
  },

  "POST /api/question-response": async (req, _url, config) => {
    const { sessionId, answer } = await body(req);
    const agent = await mounted(sessionId);
    if (!config.answer) throw fail(400, "Answering agents from the glasses is off.");
    if (!answer || answer === "skip") await call("hc", ["keys", agent.id, "esc"]);
    else await call("hc", ["send", "--force", agent.id, String(answer)], 90000);
    return { ok: true };
  },
};

async function history(id, url, config) {
  await mounted(id);
  const lines = await readLines(id, config.history_lines);
  const s = session(id);
  freshLines(s, lines); // shown here, so the stream won't repeat it
  return { history: [{ role: "assistant", text: tail(lines, Math.min(config.history_lines, 200)) }] };
}

// Mounting: the stream the glasses stay on while an agent is selected.
function events(req, res, url) {
  const id = url.searchParams.get("sessionId");
  if (!id) return send(res, 400, { error: "Missing 'sessionId' query parameter" });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(":ok\n\n");
  const s = session(id);
  if (url.searchParams.get("needReplay") === "true") {
    for (const entry of s.messages) res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
  }
  s.clients.add(res);
  console.log(`[mount] ${id} (${s.clients.size} watching)`);
  const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    s.clients.delete(res);
    s.touched = Date.now();
    console.log(`[unmount] ${id} (${s.clients.size} watching)`);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const config = readConfig();
  if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  if (!authorized(req, url, config)) return send(res, 401, { error: { code: "auth_failed", message: "Unauthorized" } });
  const asked = url.searchParams.get("provider");
  if (asked && !PROVIDERS.includes(asked)) return send(res, 400, { error: `Unsupported provider "${asked}". Supported providers: ${PROVIDERS.join(", ")}` });
  try {
    if (req.method === "GET" && url.pathname === "/api/events") return events(req, res, url);
    const past = req.method === "GET" && url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!past && !route) return send(res, 404, { error: "Not found" });
    const { status = 200, ...result } = past ? await history(decodeURIComponent(past[1]), url, config) : await route(req, url, config);
    send(res, status, result);
  } catch (err) {
    if (!err.status) console.error(`[${req.method} ${url.pathname}] ${err.message}`);
    send(res, err.status ?? 500, { error: err.message });
  }
}

function serve() {
  const config = ensureConfig();
  const { address, problem } = reach(config);
  if (!address) {
    console.error(`error: ${problem}`);
    process.exit(1);
  }
  const listen = (host) => {
    const server = http.createServer((req, res) => handle(req, res));
    server.on("error", (err) => {
      console.error(`error: cannot listen on ${host}:${config.port}: ${err.message}`);
      process.exit(1);
    });
    server.listen(config.port, host);
  };
  listen(address);
  if (address !== "127.0.0.1") listen("127.0.0.1"); // the dialog checks on it here
  setInterval(tick, Math.min(5000, Math.max(500, Number(config.poll_ms) || DEFAULTS.poll_ms)));
  console.log(`Even Glasses bridge for Herdr`);
  console.log(`  Phone:  http://${address}:${config.port}`);
  console.log(`  Token:  ${config.token.slice(0, 8)}...${config.token.slice(-4)}`);
  console.log(`  Agents listed under: ${config.provider}`);
  console.log(`Pair from Herdr: Even Glasses > Pair.`);
}

const command = process.argv[2] ?? "serve";
if (command === "info" || command === "rotate") console.log(JSON.stringify(info(ensureConfig(command === "rotate"))));
else if (command === "serve") serve();
else {
  console.error(`Unknown command "${command}". Use: serve, info, rotate.`);
  process.exit(2);
}

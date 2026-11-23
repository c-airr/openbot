// Fork: the Discord Rich Presence card of this OpenBot window. It shows the app name with "fork", the
// provider and the model of the open chat. No chat text and no chat title go to Discord.
//
// Discord takes a presence over a local socket that its desktop app opens: `discord-ipc-0` to
// `discord-ipc-9`, under `XDG_RUNTIME_DIR` or `TMPDIR` on Linux, `/tmp` on macOS, and as named pipes on
// Windows. A frame is a little-endian header (opcode, length) and a JSON body. The first frame is a
// handshake with this fork's application id (a config file can name another one); after Discord answers
// READY, each `SET_ACTIVITY` frame replaces the card. The socket has to stay open: Discord drops the
// card when the pipe closes.
//
// With Discord not running, every call does nothing and never keeps an agent waiting. A dropped pipe
// retries on its own, because the card is not sent again until the open chat's model changes.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { DiscordPresenceInput } from "@openbot/contracts/ipc";
import { Option, Schema } from "effect";
import { app, BrowserWindow } from "electron";

const CONFIG_FILE = "openbot-discord-presence-v1.json";
const RETRY_MS = 60_000;
const CONNECT_TIMEOUT_MS = 1_000;
const IDLE_MS = 10 * 60_000;
const FOCUS_CHECK_MS = 2_000;
const APP_STARTED_AT = Date.now();
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;

/**
 * The application id of this fork's Discord application, which gives the card its name and image. It is
 * public: Discord shows it in every client that sends a presence. The config file can name another one.
 */
const DEFAULT_CLIENT_ID = "1571274964332453980";

/** The card's first line: the app, with the word that tells this build from the release. */
const APP_LINE = "OpenBot (fork)";

/**
 * The card's image: the fork's own icon in the public repository. Discord accepts an external image
 * URL here and serves it from its own proxy, so the card needs no asset uploaded to the application.
 */
const LOGO_URL = "https://raw.githubusercontent.com/c-airr/openbot/main/build/icon-production.png";

/** The config file: the application id, and the image key when the developer uploaded one. */
const Config = Schema.Struct({
  clientId: Schema.String,
  largeImageKey: Schema.optionalKey(Schema.String),
});
type PresenceConfig = typeof Config.Type;

const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(Config));

/** Discord's dispatch frame, of which only the event name decides when the handshake is done. */
const Dispatch = Schema.Struct({ evt: Schema.optionalKey(Schema.String) });
const decodeDispatch = Schema.decodeUnknownOption(Schema.fromJsonString(Dispatch));

/** The sockets to try, in Discord's own order: a running Discord answers on one of the first ones. */
function socketPaths(): string[] {
  if (process.platform === "win32") {
    return Array.from({ length: 10 }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  }
  const base = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? "/tmp";
  return Array.from({ length: 10 }, (_, index) => join(base, `discord-ipc-${index}`));
}

/** The config: the fork's own application id, or the one in the config file, which also sets an image. */
async function readConfig(): Promise<PresenceConfig> {
  const text = await readFile(join(app.getPath("userData"), CONFIG_FILE), "utf8").catch(() => null);
  const config = text === null ? null : Option.getOrNull(decodeConfig(text));
  const clientId = config?.clientId.trim() ?? "";
  const largeImageKey = config?.largeImageKey?.trim();
  return {
    clientId: /^\d{5,25}$/u.test(clientId) ? clientId : DEFAULT_CLIENT_ID,
    ...(largeImageKey ? { largeImageKey } : {}),
  };
}

function encodeFrame(opcode: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * The card that Discord shows: the app line, then the model and the provider of the open chat. Nothing
 * else of the app goes out, so the card shows what the user chose, not what they talk about.
 */
function presenceActivity(input: DiscordPresenceInput, config: PresenceConfig, idle: boolean, running: number) {
  const model = input.model ? modelLabel(input.model, input.effort) : null;
  const provider = input.provider ? providerLabel(input.provider, input.model) : null;
  const state = [running > 0 ? `${running} ${running === 1 ? "agent" : "agents"} running` : null, model, provider]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return {
    details: idle ? `${APP_LINE} · Idle` : APP_LINE,
    ...(state ? { state: state.slice(0, 128) } : {}),
    timestamps: { start: APP_STARTED_AT },
    // The uploaded image of the config file wins; without one, the card shows the fork's own icon.
    assets: { large_image: config.largeImageKey ?? LOGO_URL, large_text: APP_LINE },
    instance: false,
  };
}

/** An identifier such as `claude-opus-5-5-medium` reads as "Claude Opus 5.5 Medium", plus its effort. */
function modelLabel(model: string, effort: string | null): string {
  const bare = model.split("/").at(-1) ?? model;
  const human = bare
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/[-_]+/gu, " ")
    .replace(/\b(\d)\s(\d)\b/gu, "$1.$2")
    .replace(/\s+/gu, " ")
    .trim();
  const titled = human
    .split(" ")
    .map((word) => (word.length > 2 && /^[a-z]/u.test(word) ? (word[0]?.toUpperCase() ?? "") + word.slice(1) : word))
    .join(" ");
  return effort ? `${titled} · ${effort}` : titled;
}

/** The provider as the card names it: an agent on a custom endpoint says so. */
function providerLabel(provider: string, model: string | null): string {
  if (provider === "acp") return "Custom agent";
  if (provider === "opencode" && model?.includes("/")) return "OpenCode · custom endpoint";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * One connection to the Discord desktop app. It reconnects on a later update after Discord restarts,
 * and a failed connection stays silent: the caller never waits for the card.
 */
class DiscordPresence {
  #config: PresenceConfig | null = null;
  #socket: Socket | null = null;
  #ready = false;
  #buffer: Buffer = Buffer.alloc(0);
  #pending: DiscordPresenceInput | null = null;
  #retryAt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #lastFocused = Date.now();
  #idle = false;
  #running = 0;
  #readRunning: () => number = () => 0;

  setRunningSource(read: () => number): void {
    this.#readRunning = read;
  }

  constructor() {
    app.on("browser-window-focus", () => {
      this.#lastFocused = Date.now();
      if (!this.#idle) return;
      this.#idle = false;
      if (this.#pending && this.#ready) this.#publish(this.#pending);
    });
    app.on("browser-window-blur", () => {
      this.#lastFocused = Date.now();
    });
    const timer = setInterval(() => {
      if (BrowserWindow.getAllWindows().some((window) => window.isFocused())) this.#lastFocused = Date.now();
      const running = this.#readRunning();
      const idle = running === 0 && Date.now() - this.#lastFocused >= IDLE_MS;
      if (idle === this.#idle && running === this.#running) return;
      this.#idle = idle;
      this.#running = running;
      if (this.#pending && this.#ready) this.#publish(this.#pending);
    }, FOCUS_CHECK_MS);
    timer.unref();
  }

  async update(input: DiscordPresenceInput): Promise<void> {
    this.#config ??= await readConfig();
    this.#pending = input;
    if (!this.#ready) {
      if (Date.now() < this.#retryAt) return;
      // A handshake already in flight publishes the card when READY arrives.
      if (this.#socket && !this.#socket.destroyed) return;
      await this.#open();
      if (!this.#ready) return;
    }
    this.#publish(input);
  }

  #publish(input: DiscordPresenceInput): void {
    const socket = this.#socket;
    const config = this.#config;
    if (!socket || socket.destroyed || !config) return;
    socket.write(
      encodeFrame(OP_FRAME, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity: presenceActivity(input, config, this.#idle, this.#running) },
        nonce: randomUUID(),
      }),
    );
  }

  async #open(): Promise<void> {
    for (const path of socketPaths()) {
      const socket = await connectSocket(path);
      if (!socket) continue;
      this.#socket = socket;
      this.#buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        if (this.#socket !== socket) return;
        this.#receive(chunk);
      });
      // Only this socket may drop the card. A previous pipe's close must not kill the new one.
      socket.on("error", () => this.#close(socket));
      socket.on("close", () => this.#close(socket));
      socket.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.#config?.clientId }));
      return;
    }
    this.#armRetry();
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 8) {
      const opcode = this.#buffer.readInt32LE(0);
      const length = this.#buffer.readInt32LE(4);
      if (this.#buffer.length < 8 + length) return;
      const body = this.#buffer.subarray(8, 8 + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(8 + length);
      if (opcode !== OP_FRAME) continue;
      // READY ends the handshake: the card that waited for it is then sent, once.
      if (Option.getOrNull(decodeDispatch(body))?.evt === "READY" && !this.#ready) {
        this.#ready = true;
        if (this.#pending) this.#publish(this.#pending);
      }
    }
  }

  #close(socket: Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#ready = false;
    this.#buffer = Buffer.alloc(0);
    socket.destroy();
    this.#armRetry();
  }

  /** Tries the same card again later. The renderer does not send it again until the model changes. */
  #armRetry(): void {
    this.#retryAt = Date.now() + RETRY_MS;
    const pending = this.#pending;
    if (!pending) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#pending) void this.update(this.#pending).catch(() => undefined);
    }, RETRY_MS);
    this.#retryTimer.unref();
  }
}

function connectSocket(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let settled = false;
    const timer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);
    timer.unref();
    // One result only. The timeout used to run after a successful connect and destroy the pipe,
    // so Discord dropped the card about a second after it appeared.
    const finish = (result: Socket | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!result) socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(socket));
    socket.once("error", () => finish(null));
  });
}

const presence = new DiscordPresence();

/** Sets the card that Discord shows, or clears it when no chat is open. Never throws at the caller. */
export function setDiscordPresence(input: DiscordPresenceInput): void {
  void presence.update(input).catch(() => undefined);
}

export function setDiscordRunningSource(read: () => number): void {
  presence.setRunningSource(read);
}

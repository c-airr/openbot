// Fork: the Discord Rich Presence card of the desktop app. The renderer sends only what the card
// shows - the provider, the model and its effort - so no chat text and no chat name leave the computer.
//
// The presence needs a Discord application id, which a personal fork does not ship: it comes from
// `openbot-discord-presence-v1.json` ({ "clientId": "1234567890" }) in the app data folder. Without
// that file the app sends nothing, as the FreeLLMAPI rail stays away without its own config file.

import { isDynamicRecord } from "./runtime-values";

export interface DiscordPresenceInput {
  enabled?: boolean;
  /** The provider of the open chat's agent, such as `claude` or `codex`. Null when no chat is open. */
  provider: string | null;
  /** The model of that agent, such as `claude-opus-5-5-medium`. Null when no chat is open. */
  model: string | null;
  /** The reasoning effort of that agent, when the model has one. */
  effort: string | null;
}

function nullableText(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid Discord presence text.");
  const text = value.trim();
  return text ? text.slice(0, limit) : null;
}

export function parseDiscordPresenceInput(value: unknown): DiscordPresenceInput {
  if (!isDynamicRecord(value)) throw new Error("Invalid Discord presence.");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Invalid Discord presence.");
  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    provider: nullableText(value.provider, 40),
    model: nullableText(value.model, 80),
    effort: nullableText(value.effort, 40),
  };
}

// Fork: keeps the Discord Rich Presence card in step with the open chat. It sends only the provider,
// the model and the reasoning effort - what the user chose - and nothing of the conversation, so the
// card can never show a chat title, a file name or a message. A window with no chat open clears it.

import { createEffect } from "solid-js";
import { appPort } from "../../app-port";
import { useAgents } from "../agents/agents-context";
import { discordPresenceEnabled } from "./discord-presence-preference";

export function DiscordPresenceReporter() {
  const { activeAgent } = useAgents();
  /** The three values that the card names, from the agent of the open chat. */
  const presence = () => {
    const agent = activeAgent();
    const enabled = discordPresenceEnabled();
    if (!agent) return { enabled, provider: null, model: null, effort: null };
    return {
      enabled,
      provider: agent.provider,
      model: agent.model,
      effort: agent.reasoningEffort ?? null,
    };
  };
  // The card changes only when one of these three changes: a new message, a new turn or a streamed
  // word of an answer must not talk to Discord again.
  createEffect(
    () => {
      const value = presence();
      return `${value.enabled}\u0000${value.provider ?? ""}\u0000${value.model ?? ""}\u0000${value.effort ?? ""}`;
    },
    () => {
      void appPort()
        .setDiscordPresence(presence())
        .catch(() => undefined);
    },
  );
  return null;
}

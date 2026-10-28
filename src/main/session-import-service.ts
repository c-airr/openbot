// Fork: turns sessions of other coding apps into chats.
//
// `resume` binds the chat to the app's own session, so the provider carries on from it and
// OpenBot reads the history back. `paste` and `compact` start a fresh chat whose first message
// holds the conversation, so any model can pick it up.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentProviderId,
  ApplySessionImportInput,
  SessionImportResult,
  SessionImportSource,
} from "@openbot/contracts/ipc";
import type { AgentService } from "../backend/agent-service";
import { runCauseEffect } from "../backend/effect-boundary";
import { readSessionTranscript, transcriptText } from "./session-import-sources";

const SOURCE_PROVIDER: Record<SessionImportSource, AgentProviderId | null> = {
  "cursor-cli": "cursor",
  "cursor-ide": null,
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
};

const SOURCE_LABEL: Record<SessionImportSource, string> = {
  "cursor-cli": "Cursor",
  "cursor-ide": "Cursor",
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

/** Room for the framing text around the conversation. */
const FRAME_ALLOWANCE = 1_500;

const COMPACT_INSTRUCTION =
  "Compact the conversation below into a briefing another AI model can continue from. Keep the goal, decisions made, " +
  "the current state of the work, file paths, commands, names and anything still unfinished. Drop small talk and " +
  "dead ends. Write it as plain text, no preamble.";

/** The folder when it is still there, else nothing. */
async function existingFolder(path: string | null): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return (await stat(path)).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

export async function importSessions(
  service: AgentService,
  input: ApplySessionImportInput,
): Promise<SessionImportResult> {
  const result: SessionImportResult = { agentIds: [], failed: [] };
  for (const key of input.keys) {
    try {
      const { session, turns } = await readSessionTranscript(key);
      if (turns.length === 0) throw new Error("This session has no messages to import.");
      const id = key.slice(session.source.length + 1);
      const folder = await existingFolder(session.cwd);
      const base = {
        name: session.title.slice(0, INPUT_LIMITS.agentName),
        description: `${SOURCE_LABEL[session.source]}`,
        avatarSeed: randomUUID(),
        avatarHue: null,
        ...(folder ? { workspaceFolder: folder } : {}),
      };
      const source = SOURCE_LABEL[session.source];
      if (input.mode === "resume") {
        const provider = SOURCE_PROVIDER[session.source];
        if (!provider || !session.resumable)
          throw new Error(`${source} cannot reopen this session. Use paste or compact.`);
        if (!folder)
          throw new Error("The folder of this session is gone, and the app finds the session by its folder.");
        const agent = await runCauseEffect(service.createAgent({ ...base, initialMessage: "", blank: true, provider }));
        // A chat that could not take the session would be an empty one the user did not ask for.
        try {
          await runCauseEffect(service.attachProviderSession(agent.id, provider, id));
        } catch (error) {
          await runCauseEffect(service.deleteAgent(agent.id)).catch(() => undefined);
          throw error;
        }
        result.agentIds.push(agent.id);
        continue;
      }
      if (input.mode === "paste") {
        const prompt = input.prompt.trim() || "Carry on from where this conversation stopped.";
        const body = transcriptText(turns, INPUT_LIMITS.messageText - prompt.length - FRAME_ALLOWANCE);
        const initialMessage = `This is an earlier conversation from ${source}, copied in so you can continue it.\n\n${body}\n\n---\n${prompt}`;
        const agent = await runCauseEffect(service.createAgent({ ...base, initialMessage }));
        result.agentIds.push(agent.id);
        continue;
      }
      const instruction = input.prompt.trim() ? `${COMPACT_INSTRUCTION}\n${input.prompt.trim()}` : COMPACT_INSTRUCTION;
      const body = transcriptText(turns, INPUT_LIMITS.messageText - instruction.length - FRAME_ALLOWANCE);
      const agent = await runCauseEffect(
        service.createAgent({
          ...base,
          initialMessage: `${instruction}\n\n${body}`,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
        }),
      );
      result.agentIds.push(agent.id);
    } catch (error) {
      result.failed.push({ key, message: error instanceof Error ? error.message : "Import failed." });
    }
  }
  return result;
}

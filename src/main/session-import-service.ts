// Fork: turns sessions of other coding apps into chats.
//
// Every method makes the same thing: a new chat, plus one note that names the app and the method.
// `resume` then binds that chat to the app's own session. `paste` and `compact` then send one
// message that holds the conversation, so any model can pick it up.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentProviderId,
  ApplySessionImportInput,
  SessionImportMode,
  SessionImportResult,
  SessionImportSource,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
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

const IMPORT_NOTE: Record<
  SessionImportMode,
  "status.agent.sessionImported.resume" | "status.agent.sessionImported.paste" | "status.agent.sessionImported.compact"
> = {
  resume: "status.agent.sessionImported.resume",
  paste: "status.agent.sessionImported.paste",
  compact: "status.agent.sessionImported.compact",
};

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
      const source = SOURCE_LABEL[session.source];
      const note = sourceText(IMPORT_NOTE[input.mode], { source });
      const provider = SOURCE_PROVIDER[session.source];
      if (input.mode === "resume") {
        if (!provider || !session.resumable)
          throw new Error(`${source} cannot reopen this session. Use paste or compact.`);
        if (!folder)
          throw new Error("The folder of this session is gone, and the app finds the session by its folder.");
      }
      // The same new chat for every method. The note is its description, its sidebar line, and a marker.
      const agent = await runCauseEffect(
        service.createAgent({
          name: session.title.slice(0, INPUT_LIMITS.agentName),
          description: note,
          avatarSeed: randomUUID(),
          avatarHue: null,
          initialMessage: "",
          blank: true,
          ...(folder ? { workspaceFolder: folder } : {}),
          ...(input.mode === "resume" && provider ? { provider } : {}),
          ...(input.mode === "compact" && input.provider ? { provider: input.provider } : {}),
          ...(input.mode === "compact" && input.model ? { model: input.model } : {}),
        }),
      );
      try {
        await runCauseEffect(service.appendSessionImportNote(agent.id, note));
        if (input.mode === "resume") {
          if (!provider) throw new Error(`${source} cannot reopen this session. Use paste or compact.`);
          await runCauseEffect(service.attachProviderSession(agent.id, provider, id));
        } else if (input.mode === "paste") {
          const prompt = input.prompt.trim() || "Carry on from where this conversation stopped.";
          const body = transcriptText(turns, INPUT_LIMITS.messageText - prompt.length - FRAME_ALLOWANCE);
          await runCauseEffect(
            service.sendMessage({
              agentId: agent.id,
              text: `This is an earlier conversation from ${source}, copied in so you can continue it.\n\n${body}\n\n---\n${prompt}`,
              attachmentDraftIds: [],
            }),
          );
          // The sent text replaced the sidebar line. Put the note back.
          await runCauseEffect(service.appendSessionImportNote(agent.id, note, false));
        } else {
          const instruction = input.prompt.trim()
            ? `${COMPACT_INSTRUCTION}\n${input.prompt.trim()}`
            : COMPACT_INSTRUCTION;
          const body = transcriptText(turns, INPUT_LIMITS.messageText - instruction.length - FRAME_ALLOWANCE);
          await runCauseEffect(
            service.sendMessage({
              agentId: agent.id,
              text: `${instruction}\n\n${body}`,
              attachmentDraftIds: [],
            }),
          );
          await runCauseEffect(service.appendSessionImportNote(agent.id, note, false));
        }
      } catch (error) {
        await runCauseEffect(service.deleteAgent(agent.id)).catch(() => undefined);
        throw error;
      }
      result.agentIds.push(agent.id);
    } catch (error) {
      result.failed.push({ key, message: error instanceof Error ? error.message : "Import failed." });
    }
  }
  return result;
}

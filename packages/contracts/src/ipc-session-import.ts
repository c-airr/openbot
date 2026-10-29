/**
 * Fork: sessions that other coding apps keep on this computer, listed so a chat can pick one up.
 *
 * Main reads the apps' own folders. The renderer names sessions by `key` and never sees a path
 * except the working folder it shows in the list.
 */

import { type AgentProviderId, isAgentProvider } from "./agent-providers";
import { type AgentModelId, isAgentModel } from "./ipc-agent-identity";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export const SESSION_IMPORT_SOURCES = [
  "cursor-cli",
  "cursor-ide",
  "codex",
  "claude",
  "opencode",
  "antigravity",
] as const;
export type SessionImportSource = (typeof SESSION_IMPORT_SOURCES)[number];

/**
 * Every mode makes a new chat and a note that names the app and the method.
 * `resume`: that chat carries on from the session itself, with its history.
 * `paste`: the chat's first message holds the conversation, followed by the user's own text.
 * `compact`: the chat asks the chosen model to boil the conversation down.
 */
export const SESSION_IMPORT_MODES = ["resume", "paste", "compact"] as const;
export type SessionImportMode = (typeof SESSION_IMPORT_MODES)[number];

export interface ImportableSession {
  /** `<source>:<id>`. */
  key: string;
  source: SessionImportSource;
  title: string;
  cwd: string | null;
  /** Milliseconds since the epoch. */
  updatedAt: number;
  /** The provider can open this session again, so `resume` works. */
  resumable: boolean;
}

export interface ApplySessionImportInput {
  keys: string[];
  mode: SessionImportMode;
  /** `paste`: written after the conversation. `compact`: added to the instruction. */
  prompt: string;
  /** `compact`: the model that does the work. */
  provider?: AgentProviderId;
  model?: AgentModelId;
}

export interface SessionImportFailure {
  key: string;
  message: string;
}

export interface SessionImportResult {
  agentIds: string[];
  failed: SessionImportFailure[];
}

const MAX_KEYS = 200;

export function isImportableSession(value: unknown): value is ImportableSession {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.key) &&
    isOneOf(SESSION_IMPORT_SOURCES, value.source) &&
    isString(value.title) &&
    (value.cwd === null || isString(value.cwd)) &&
    isNumber(value.updatedAt) &&
    isBoolean(value.resumable)
  );
}

export function parseApplySessionImportInput(value: unknown): ApplySessionImportInput {
  if (!isDynamicRecord(value)) throw new Error("Invalid session import request.");
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > MAX_KEYS)
    throw new Error("Choose between 1 and 200 sessions.");
  if (!value.keys.every(isIdentifier)) throw new Error("Invalid session key.");
  if (!isOneOf(SESSION_IMPORT_MODES, value.mode)) throw new Error("Invalid import mode.");
  if (!isBoundedString(value.prompt, 20_000)) throw new Error("The text is too long.");
  const result: ApplySessionImportInput = { keys: value.keys, mode: value.mode, prompt: value.prompt };
  if (value.provider !== undefined) {
    if (!isAgentProvider(value.provider)) throw new Error("Invalid agent provider.");
    result.provider = value.provider;
  }
  if (value.model !== undefined) {
    if (!isAgentModel(value.model)) throw new Error("Invalid agent model.");
    result.model = value.model;
  }
  return result;
}

export function decodeImportableSessions(value: unknown): ImportableSession[] {
  if (!Array.isArray(value) || !value.every(isImportableSession)) throw new Error("Invalid session list.");
  return value;
}

export function decodeSessionImportResult(value: unknown): SessionImportResult {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.agentIds) ||
    !value.agentIds.every(isString) ||
    !Array.isArray(value.failed)
  )
    throw new Error("Invalid session import result.");
  const failed: SessionImportFailure[] = [];
  for (const item of value.failed) {
    if (!isDynamicRecord(item) || !isString(item.key) || !isString(item.message))
      throw new Error("Invalid session import result.");
    failed.push({ key: item.key, message: item.message });
  }
  return { agentIds: value.agentIds, failed };
}

/** Fork: a memory for every chat. Without `memoryId` it is a new one. */
export interface SaveSharedMemoryInput {
  text: string;
  memoryId?: string;
}

export function parseSaveSharedMemoryInput(value: unknown): SaveSharedMemoryInput {
  if (!isDynamicRecord(value) || !isBoundedString(value.text, 2_000) || !value.text.trim())
    throw new Error("Invalid shared memory.");
  if (value.memoryId === undefined) return { text: value.text };
  if (!isIdentifier(value.memoryId)) throw new Error("Invalid shared memory id.");
  return { text: value.text, memoryId: value.memoryId };
}

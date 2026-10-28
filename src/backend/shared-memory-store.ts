// Fork: memories that every chat gets, whatever its provider. One JSON file in the user data folder.
//
// Synchronous on purpose: the prompt of a chat is built synchronously, and the file is a few KB.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { essentialMemoryBytes } from "@openbot/contracts/agent-memory-context";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type AgentMemory, isMemoryEntry, type MemoryEntry } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/** Ids of shared memories carry this prefix, so a model can tell them from its own. */
export const SHARED_MEMORY_PREFIX = "shared:";
/** The agent id the shared memories carry in a prompt. */
export const SHARED_MEMORY_OWNER = "shared";
export const SHARED_MEMORY_LIMIT = 100;
/** The part of a chat's essential-memory block that shared memories may fill; the chat's own get the rest. */
export const SHARED_MEMORY_PROMPT_BYTES = 4096;

export class SharedMemoryStore {
  readonly #path: string;
  #entries: MemoryEntry[];

  constructor(path: string) {
    this.#path = path;
    this.#entries = read(path);
  }

  list(): MemoryEntry[] {
    return [...this.#entries];
  }

  /** The newest that fit the shared part of the prompt, oldest first. */
  forPrompt(): AgentMemory[] {
    const picked: AgentMemory[] = [];
    for (const entry of [...this.#entries].reverse()) {
      const memory = { ...entry, agentId: SHARED_MEMORY_OWNER };
      if (essentialMemoryBytes([...picked, memory]) > SHARED_MEMORY_PROMPT_BYTES) break;
      picked.unshift(memory);
    }
    return picked;
  }

  /** Adds a memory, or replaces the one with `id`. The same text twice is kept once. */
  save(text: string, origin: MemoryEntry["origin"], id?: string): MemoryEntry {
    const clean = text.trim();
    if (!clean) throw new Error("The memory is empty.");
    if (clean.length > INPUT_LIMITS.agentMemoryText) throw new Error("The memory is too long.");
    const now = new Date().toISOString();
    if (id !== undefined) {
      const current = this.#entries.find((entry) => entry.id === id);
      if (!current) throw new Error("There is no shared memory with this id.");
      const updated = { ...current, text: clean, updatedAt: now };
      this.#write(this.#entries.map((entry) => (entry.id === id ? updated : entry)));
      return updated;
    }
    const same = this.#entries.find((entry) => entry.text.toLowerCase() === clean.toLowerCase());
    if (same) return same;
    if (this.#entries.length >= SHARED_MEMORY_LIMIT)
      throw new Error(`Shared memory is full (${SHARED_MEMORY_LIMIT}). Merge or forget one first.`);
    const entry: MemoryEntry = {
      id: `${SHARED_MEMORY_PREFIX}${randomUUID()}`,
      text: clean,
      origin,
      sourceTurnId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#write([...this.#entries, entry]);
    return entry;
  }

  remove(id: string): boolean {
    const next = this.#entries.filter((entry) => entry.id !== id);
    if (next.length === this.#entries.length) return false;
    this.#write(next);
    return true;
  }

  #write(entries: MemoryEntry[]): void {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, memories: entries })}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
    this.#entries = entries;
  }
}

/** A missing or damaged file is an empty memory: losing it must not stop a chat from starting. */
function read(path: string): MemoryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isDynamicRecord(parsed) || !Array.isArray(parsed.memories)) return [];
    return parsed.memories.filter(isMemoryEntry);
  } catch {
    return [];
  }
}

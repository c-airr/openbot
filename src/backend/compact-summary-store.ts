// Fork: the briefing that /compact leaves for a chat whose context was reset. One JSON file in the user data folder.
//
// Synchronous on purpose: the prompt of a chat is built synchronously.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/** About 4,000 words. A briefing that is longer is cut. */
export const COMPACT_SUMMARY_MAX_CHARS = 24_000;

export class CompactSummaryStore {
  readonly #path: string;
  #summaries: Record<string, string>;

  constructor(path: string) {
    this.#path = path;
    this.#summaries = read(path);
  }

  get(agentId: string): string | null {
    return this.#summaries[agentId] ?? null;
  }

  set(agentId: string, summary: string): void {
    const text = summary.trim().slice(0, COMPACT_SUMMARY_MAX_CHARS);
    if (!text) throw new Error("The summary is empty.");
    this.#summaries = { ...this.#summaries, [agentId]: text };
    this.#write();
  }

  remove(agentId: string): void {
    if (!(agentId in this.#summaries)) return;
    const { [agentId]: _removed, ...rest } = this.#summaries;
    this.#summaries = rest;
    this.#write();
  }

  #write(): void {
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#summaries), "utf8");
    renameSync(temporary, this.#path);
  }
}

function read(path: string): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isDynamicRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

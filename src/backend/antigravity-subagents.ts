// Fork: Antigravity runs each subagent in a conversation of its own and writes that conversation's
// steps to `brain/<id>/.system_generated/logs/transcript.jsonl`. ACP shows OpenBot only the
// `invoke_subagent` call, so the chat stayed silent until the final answer. This reads the
// transcripts and gives the chat the same subagent list that Claude's `Agent` calls produce.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ConversationSubagent,
  type ConversationSubagentStep,
  type ConversationSubagentStepKind,
  clampConversationSubagents,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { isRecord } from "./protocol";

const POLL_MS = 1_500;
/** A subagent that wrote nothing for this long is shown as stopped, and its file is no longer read. */
const IDLE_STOP_MS = 20 * 60_000;

/** One entry of the `Subagents` argument of `invoke_subagent`. */
export interface InvokedSubagent {
  role: string;
  prompt: string;
  typeName: string | null;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function parseJson(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The subagents that an `invoke_subagent` call asked for, or an empty list for any other input. */
export function invokedSubagents(rawInput: unknown): InvokedSubagent[] {
  if (!isRecord(rawInput)) return [];
  const list = isString(rawInput.Subagents) ? parseJson(rawInput.Subagents) : rawInput.Subagents;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): InvokedSubagent[] => {
    if (!isRecord(entry)) return [];
    const prompt = isString(entry.Prompt) ? entry.Prompt : "";
    const role = isString(entry.Role) && entry.Role.trim() ? entry.Role.trim() : (prompt.split("\n")[0] ?? "").trim();
    const typeName = isString(entry.TypeName) && entry.TypeName !== "self" ? entry.TypeName : null;
    return [{ role, prompt, typeName }];
  });
}

/** The conversation ids in the text that Antigravity writes for a created subagent, in order. */
export function conversationIds(text: string): string[] {
  return [...text.matchAll(/"conversationId"\s*:\s*"([0-9A-Za-z-]{8,})"/gu)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

export interface TranscriptCall {
  name: string;
  /** Only the text arguments, which are all that a step shows. */
  args: Record<string, string>;
}

export interface TranscriptRow {
  index: number | null;
  type: string;
  createdAt: string | null;
  content: string;
  calls: TranscriptCall[];
}

function parseRow(value: unknown): TranscriptRow | null {
  if (!isRecord(value)) return null;
  const calls = Array.isArray(value.tool_calls)
    ? value.tool_calls.flatMap((call): TranscriptCall[] => {
        if (!isRecord(call) || !isString(call.name)) return [];
        const args: Record<string, string> = {};
        if (isRecord(call.args)) for (const [key, arg] of Object.entries(call.args)) if (isString(arg)) args[key] = arg;
        return [{ name: call.name, args }];
      })
    : [];
  return {
    index: typeof value.step_index === "number" ? value.step_index : null,
    type: isString(value.type) ? value.type : "",
    createdAt: isString(value.created_at) ? value.created_at : null,
    content: isString(value.content) ? value.content : "",
    calls,
  };
}

export function parseTranscript(text: string): TranscriptRow[] {
  return text.split("\n").flatMap((line) => {
    const row = line.trim() ? parseRow(parseJson(line)) : null;
    return row ? [row] : [];
  });
}

/** Antigravity writes each argument as JSON text, so `"\"ls\""` is the string `ls`. */
function argument(args: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    const parsed = parseJson(value);
    return isString(parsed) ? parsed : value;
  }
  return "";
}

function toolStep(call: TranscriptCall): { kind: ConversationSubagentStepKind; text: string } {
  const { args } = call;
  switch (call.name) {
    case "run_command":
      return { kind: "command", text: argument(args, "CommandLine", "toolAction") };
    case "view_file":
    case "list_dir":
      return { kind: "read", text: argument(args, "AbsolutePath", "DirectoryPath", "Path", "toolAction") };
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return { kind: "edit", text: argument(args, "TargetFile", "AbsolutePath", "toolAction") };
    case "grep_search":
    case "find_by_name":
      return { kind: "search", text: argument(args, "Query", "Pattern", "SearchPath", "toolAction") };
    case "search_web":
    case "read_url_content":
      return { kind: "web", text: argument(args, "query", "Url", "toolAction") };
    case "send_message":
      return { kind: "text", text: argument(args, "Message", "toolAction") };
    default:
      return { kind: "tool", text: argument(args, "toolAction", "toolSummary") || call.name };
  }
}

/** The steps a transcript shows and whether the subagent reported back, which is how it ends. */
export function readTranscript(
  conversationId: string,
  rows: readonly TranscriptRow[],
): { steps: ConversationSubagentStep[]; reportedAt: string | null; lastAt: string | null } {
  const steps: ConversationSubagentStep[] = [];
  let reportedAt: string | null = null;
  let lastAt: string | null = null;
  for (const row of rows) {
    if (row.createdAt) lastAt = row.createdAt;
    if (row.type !== "PLANNER_RESPONSE") continue;
    const index = row.index ?? steps.length;
    const text = row.content.trim();
    if (text) steps.push({ id: `${conversationId}:${index}`, kind: "text", text });
    row.calls.forEach((call, position) => {
      const step = toolStep(call);
      if (call.name === "send_message") reportedAt = row.createdAt ?? lastAt;
      if (step.text) steps.push({ id: `${conversationId}:${index}:${position}`, ...step });
    });
  }
  return { steps, reportedAt, lastAt };
}

interface Call {
  toolCallId: string;
  turnId: string;
  startedAt: string;
  subagents: ConversationSubagent[];
  /** The conversation of each subagent, once the parent transcript names it. */
  conversations: (string | null)[];
  /** Last time a subagent of this call wrote a row. */
  activityAt: number;
}

export interface AntigravitySubagentChange {
  threadId: string;
  turnId: string;
  subagents: ConversationSubagent[];
}

export interface AntigravitySubagentOptions {
  /** `brain` folder of the Antigravity server, with one folder per conversation. */
  brainDirectory: string;
  emit: (change: AntigravitySubagentChange) => void;
  intervalMs?: number;
  now?: () => number;
}

const transcriptPath = (brain: string, conversationId: string) =>
  join(brain, conversationId, ".system_generated", "logs", "transcript.jsonl");

async function readRows(path: string): Promise<TranscriptRow[]> {
  try {
    return parseTranscript(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

export class AntigravitySubagents {
  readonly #options: AntigravitySubagentOptions;
  /** Calls by session id, in start order. */
  readonly #sessions = new Map<string, Call[]>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;

  constructor(options: AntigravitySubagentOptions) {
    this.#options = options;
  }

  /** Registers the subagents of an `invoke_subagent` call. Other tool calls and repeated updates do nothing. */
  invoked(sessionId: string, turnId: string, toolCallId: string, rawInput: unknown): void {
    const calls = this.#sessions.get(sessionId) ?? [];
    if (calls.some((call) => call.toolCallId === toolCallId)) return;
    const invoked = invokedSubagents(rawInput);
    if (invoked.length === 0) return;
    const now = this.#now();
    const startedAt = new Date(now).toISOString();
    const call: Call = {
      toolCallId,
      turnId,
      startedAt,
      conversations: invoked.map(() => null),
      activityAt: now,
      subagents: invoked.map((entry, index) => ({
        id: `${toolCallId}:${index}`,
        title: entry.role,
        agentType: entry.typeName,
        prompt: entry.prompt || null,
        status: "running",
        startedAt,
        endedAt: null,
        steps: [],
        error: null,
        background: true,
      })),
    };
    calls.push(call);
    this.#sessions.set(sessionId, calls);
    this.#emit(sessionId, call);
    this.#timer ??= setInterval(() => void this.poll(), this.#options.intervalMs ?? POLL_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#sessions.clear();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #emit(sessionId: string, call: Call): void {
    const subagents = clampConversationSubagents(
      (this.#sessions.get(sessionId) ?? []).filter((one) => one.turnId === call.turnId).flatMap((one) => one.subagents),
    );
    if (subagents) this.#options.emit({ threadId: sessionId, turnId: call.turnId, subagents });
  }

  /** Reads the transcripts once. Exposed for tests. */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      for (const [sessionId, calls] of this.#sessions) await this.#pollSession(sessionId, calls);
      const running = [...this.#sessions.values()].some((calls) =>
        calls.some((call) => call.subagents.some((subagent) => subagent.status === "running")),
      );
      if (!running && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    } finally {
      this.#polling = false;
    }
  }

  async #pollSession(sessionId: string, calls: Call[]): Promise<void> {
    const brain = this.#options.brainDirectory;
    if (calls.some((call) => call.conversations.includes(null))) {
      // The k-th INVOKE_SUBAGENT row of the parent belongs to the k-th invoke_subagent call.
      const rows = (await readRows(transcriptPath(brain, sessionId))).filter((row) => row.type === "INVOKE_SUBAGENT");
      calls.forEach((call, position) => {
        const ids = conversationIds(rows[position]?.content ?? "");
        call.conversations = call.conversations.map((known, index) => known ?? ids[index] ?? null);
      });
    }
    for (const call of calls) {
      let changed = false;
      for (const [index, subagent] of call.subagents.entries()) {
        const conversationId = call.conversations[index];
        if (subagent.status !== "running" || !conversationId) continue;
        const path = transcriptPath(brain, conversationId);
        const { steps, reportedAt, lastAt } = readTranscript(conversationId, await readRows(path));
        const modified = await stat(path).then(
          (info) => info.mtimeMs,
          () => 0,
        );
        if (modified > call.activityAt) call.activityAt = modified;
        const before = JSON.stringify([subagent.steps, subagent.status]);
        subagent.steps = steps;
        if (reportedAt) {
          subagent.status = "completed";
          subagent.endedAt = reportedAt;
        } else if (this.#now() - call.activityAt > IDLE_STOP_MS) {
          subagent.status = "stopped";
          subagent.endedAt = lastAt ?? new Date(this.#now()).toISOString();
        }
        if (before !== JSON.stringify([subagent.steps, subagent.status])) changed = true;
      }
      if (changed) this.#emit(sessionId, call);
    }
  }
}

// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AntigravitySubagentChange,
  AntigravitySubagents,
  conversationIds,
  invokedSubagents,
  parseTranscript,
  readTranscript,
} from "./antigravity-subagents";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function transcript(brain: string, id: string, rows: object[]): Promise<void> {
  const folder = join(brain, id, ".system_generated", "logs");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "transcript.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
}

describe("Antigravity subagents", () => {
  it("reads the subagents of an invoke_subagent call", () => {
    const input = {
      Subagents: JSON.stringify([
        { Role: "Reader", Prompt: "Read a.txt", TypeName: "self" },
        { Prompt: "Check b\nmore", TypeName: "explorer" },
      ]),
    };
    expect(invokedSubagents(input)).toEqual([
      { role: "Reader", prompt: "Read a.txt", typeName: null },
      { role: "Check b", prompt: "Check b\nmore", typeName: "explorer" },
    ]);
    expect(invokedSubagents({ CommandLine: "ls" })).toEqual([]);
    expect(invokedSubagents({ Subagents: "not json" })).toEqual([]);
  });

  it("finds the conversation ids in the created-subagents text", () => {
    const text = 'Created the following subagents:\n{\n  "conversationId":  "285f3a34606d4ddcd944a208c659db99",\n}';
    expect(conversationIds(text)).toEqual(["285f3a34606d4ddcd944a208c659db99"]);
  });

  it("turns planner rows into steps and ends on the report to the parent", () => {
    const rows = parseTranscript(
      [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "t1",
          content: "Looking.",
          tool_calls: [{ name: "run_command", args: { CommandLine: '"dir"' } }],
        },
        { step_index: 2, type: "ERROR_MESSAGE", created_at: "t2" },
        {
          step_index: 3,
          type: "PLANNER_RESPONSE",
          created_at: "t3",
          tool_calls: [{ name: "send_message", args: { Message: '"Done."' } }],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const result = readTranscript("c1", rows);
    expect(result.steps.map((step) => [step.kind, step.text])).toEqual([
      ["text", "Looking."],
      ["command", "dir"],
      ["text", "Done."],
    ]);
    expect(result.reportedAt).toBe("t3");
  });

  it("follows a subagent from the call to its report", async () => {
    const brain = await mkdtemp(join(tmpdir(), "openbot-agy-"));
    directories.push(brain);
    const changes: AntigravitySubagentChange[] = [];
    const watcher = new AntigravitySubagents({
      brainDirectory: brain,
      emit: (change) => changes.push(change),
      intervalMs: 60_000,
    });
    watcher.invoked("parent", "turn-1", "call-1", { Subagents: JSON.stringify([{ Role: "Reader", Prompt: "Read" }]) });
    watcher.invoked("parent", "turn-1", "call-1", { Subagents: JSON.stringify([{ Role: "Reader", Prompt: "Read" }]) });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.subagents[0]).toMatchObject({ id: "call-1:0", title: "Reader", status: "running" });

    await transcript(brain, "parent", [
      { step_index: 2, type: "INVOKE_SUBAGENT", content: 'Created: {"conversationId": "abcdef0123456789"}' },
    ]);
    await transcript(brain, "abcdef0123456789", [
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "t1",
        tool_calls: [{ name: "view_file", args: { AbsolutePath: '"C:\\\\a.txt"' } }],
      },
    ]);
    await watcher.poll();
    expect(changes.at(-1)?.subagents[0]).toMatchObject({ status: "running", steps: [{ kind: "read" }] });

    await transcript(brain, "abcdef0123456789", [
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "t1",
        tool_calls: [{ name: "send_message", args: { Message: '"All read."' } }],
      },
    ]);
    await watcher.poll();
    expect(changes.at(-1)?.subagents[0]).toMatchObject({ status: "completed", endedAt: "t1" });
    watcher.dispose();
  });
});

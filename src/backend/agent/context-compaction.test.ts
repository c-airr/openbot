import { EventEmitter } from "node:events";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { Deferred, Effect } from "effect";
import { expect, test } from "vitest";
import type { AgentClient } from "../agent-client";
import { ContextCompaction } from "./context-compaction";

const agent: AgentSummary = {
  id: "agent",
  name: "Agent",
  title: "",
  description: "",
  notifications: false,
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  threadId: null,
  workspacePath: ".",
  preview: "",
  updatedAt: null,
  avatarSeed: "agent",
  avatarHue: null,
  avatarUrl: null,
};

test("uses the 300,000-token cap for large windows and preserves the smaller-window threshold", async () => {
  const invoked: Array<[string, unknown]> = [];
  const restoreStarted = Deferred.makeUnsafe<void>();
  const restoreAllowed = Deferred.makeUnsafe<void>();
  const drained = Deferred.makeUnsafe<void>();
  const request: AgentClient["request"] = (method, params, decode) =>
    Effect.gen(function* () {
      invoked.push([method, params]);
      if (method === "thread/settings/update" && invoked.length === 3) {
        yield* Deferred.succeed(restoreStarted, undefined);
        yield* Deferred.await(restoreAllowed);
      }
      return decode({});
    });
  const client: AgentClient = Object.assign(new EventEmitter(), {
    provider: "codex" as const,
    contextCompaction: "events" as const,
    running: true,
    request,
    start: () => {},
    stop: () => Effect.void,
    notify: () => {},
    respond: () => {},
    respondError: () => {},
  });
  const compaction = new ContextCompaction({
    store: { list: () => [agent], database: { activeProviderSession: () => null } },
    providers: {
      isReady: () => true,
      clientFor: () => client,
      clientForAgent: () => client,
      listModels: () => [],
    },
    emitError: () => {},
    scheduleDrain: () => {
      if (compaction.mayDrain(agent.id)) Effect.runSync(Deferred.succeed(drained, undefined));
    },
    rotateSession: () => Effect.succeed(null),
    loadSession: () => Effect.succeed(true),
    rotatesSession: () => false,
    isStopping: () => false,
  });
  const observe = (threadId: string, totalTokens: number, modelContextWindow: number) =>
    compaction.updateBudget(threadId, { tokenUsage: { last: { totalTokens }, modelContextWindow } });

  try {
    observe("wide", 299_999, 1_000_000);
    expect(compaction.reserve(agent.id, "wide")).toBe(false);
    observe("wide", 300_000, 1_000_000);
    expect(compaction.reserve(agent.id, "wide")).toBe(true);
    await Effect.runPromise(compaction.request(agent.id, "wide"));
    expect(invoked).toEqual([
      ["thread/settings/update", { threadId: "wide", effort: "low" }],
      ["thread/compact/start", { threadId: "wide" }],
    ]);
    expect(compaction.claimTurn(agent.id, "wide", "compact")).toBe(true);
    compaction.markCompacted("wide");
    compaction.finish(agent.id, "wide", "completed");
    await Effect.runPromise(Deferred.await(restoreStarted));
    expect(compaction.mayDrain(agent.id)).toBe(false);
    expect(invoked[2]).toEqual(["thread/settings/update", { threadId: "wide", effort: "high" }]);
    await Effect.runPromise(Deferred.succeed(restoreAllowed, undefined));
    await Effect.runPromise(Deferred.await(drained));

    observe("small", 159_999, 200_000);
    expect(compaction.reserve(agent.id, "small")).toBe(false);
    compaction.expectInput("small", 4);
    expect(compaction.reserve(agent.id, "small")).toBe(true);
  } finally {
    await Effect.runPromise(Deferred.succeed(restoreAllowed, undefined));
    compaction.dispose();
  }
});

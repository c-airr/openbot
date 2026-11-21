// Checks the stored first message over the same paged reads that the chat uses to scroll back.
// Run: bun scripts/first-chat-message-e2e.ts

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentWelcomeMessage } from "@openbot/contracts/agent-welcome";
import { AGENT_WELCOME_ITEM_TYPE, type ConversationMessage } from "@openbot/contracts/ipc";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const out = resolve(import.meta.dirname, "../.openbot-build/first-chat-message-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-first-chat-message-"));
const state = join(root, "state");
const database = new OpenBotDatabase(state);
const store = new AgentStore(state, join(root, "home"), database);
const passed: string[] = [];

try {
  await runCauseEffect(store.initialize());
  for (const fixture of [
    {
      name: "New chat",
      description: "Chat",
      text: "My first prompt for a new chat.",
      storedType: undefined,
      visible: true,
    },
    {
      name: "Older fork chat",
      description: "Chat",
      text: "My first prompt from an earlier fork build.",
      storedType: AGENT_WELCOME_ITEM_TYPE,
      visible: true,
    },
    {
      name: "Generated welcome",
      description: "Chat",
      text: agentWelcomeMessage({ language: "Polski" }),
      storedType: AGENT_WELCOME_ITEM_TYPE,
      visible: false,
    },
    {
      name: "Custom welcome",
      description: "Answers questions about a project.",
      text: "Setup guidance from another client.",
      storedType: AGENT_WELCOME_ITEM_TYPE,
      visible: false,
    },
  ]) {
    const agent = await runCauseEffect(
      store.createAgent({ name: fixture.name, description: fixture.description, avatarSeed: "test", avatarHue: null }),
    );
    const threadId = store.ensureThreadIdNow(agent.id);
    const createdAt = "2031-05-05T10:00:00.000Z";
    const initial: ConversationMessage = {
      id: "first-prompt",
      turnId: "first-turn",
      author: "user",
      source: "user",
      text: fixture.text,
      createdAt,
      status: "completed",
      ...(fixture.storedType ? { itemType: fixture.storedType } : {}),
    };
    database.persistConversationChanges({
      agentId: agent.id,
      threadId,
      activeTurnId: null,
      eventType: "conversation.snapshot-updated",
      changedMessages: [
        initial,
        {
          id: "first-answer",
          turnId: "first-turn",
          author: "assistant",
          text: "First answer",
          createdAt: "2031-05-05T10:01:00.000Z",
          status: "completed",
        },
        {
          id: "later-answer",
          turnId: "later-turn",
          author: "assistant",
          text: "Later answer",
          createdAt: "2031-05-05T10:03:00.000Z",
          status: "completed",
        },
      ],
    });
    const latest = database.readConversationPage(agent.id, threadId, { type: "latest" }, 1);
    assert.deepEqual(
      latest.messages.map((message) => message.id),
      ["later-answer"],
      fixture.name,
    );
    const { olderCursor, olderCount, oldestAt } = latest.pageInfo;
    assert.ok(olderCursor, fixture.name);
    assert.equal(olderCount, fixture.visible ? 2 : 1, fixture.name);
    assert.equal(oldestAt, fixture.visible ? createdAt : "2031-05-05T10:01:00.000Z", fixture.name);
    const older = database.readConversationPage(agent.id, threadId, { type: "before", cursor: olderCursor }, 1);
    assert.deepEqual(
      older.messages.map((message) => message.id),
      fixture.visible ? ["first-prompt", "first-answer"] : ["first-answer"],
      fixture.name,
    );
    assert.equal(older.pageInfo.hasOlder, false, fixture.name);
    if (fixture.visible) {
      const [prompt] = older.messages;
      assert.equal(prompt?.text, fixture.text, fixture.name);
      assert.equal(prompt?.author, "user", fixture.name);
      assert.equal(prompt?.itemType, undefined, fixture.name);
    }
    passed.push(fixture.name);
  }
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify({ passed }, null, 2)}\n`);
  process.stdout.write(`First-message checks passed: ${passed.join(", ")}\n`);
}

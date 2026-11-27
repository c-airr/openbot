import { researchDraft } from "@openbot/contracts/chat-research";
import { expect, test } from "vitest";
import type { DeliveryContext } from "../mailbox-store";
import { type DeliveryPromptSources, deliveryPromptInput } from "./delivery-content";

const topic = "Check the background of a public archive.";
const delivery = {
  id: "delivery",
  messageId: "message",
  recipientAgentId: "agent",
  sender: { kind: "user" },
  text: researchDraft(topic),
  attachments: [],
  replyToMessageId: null,
  status: "queued",
  position: 1,
  turnId: null,
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies DeliveryContext["delivery"];
const sources = {
  agentNames: new Map(),
  snapshot: { agentId: "agent", threadId: "thread", activeTurnId: null, revision: 0, messages: [] },
  routineRun: null,
} satisfies DeliveryPromptSources;

test("expands a research command into source-checking instructions for a direct chat", () => {
  expect(researchDraft(delivery.text)).toBe(delivery.text);
  const input = deliveryPromptInput({ delivery, managedAttachments: [] }, sources);
  expect(input).toEqual([{ type: "text", text: expect.stringContaining("cite direct links") }]);
  expect(input[0]).toMatchObject({ text: expect.stringContaining(topic) });
  expect(input[0]).not.toMatchObject({ text: expect.stringContaining("/research") });
});

test("preserves slash-prefixed text from an external chat", () => {
  const input = deliveryPromptInput({ delivery, managedAttachments: [] }, { ...sources, externalChat: true });
  expect(input).toEqual([{ type: "text", text: delivery.text }]);
});

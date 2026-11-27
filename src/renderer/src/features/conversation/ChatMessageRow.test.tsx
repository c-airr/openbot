import type { AgentMessage } from "@openbot/ui/data";
import { ChatMessageRow } from "@openbot/ui/features/conversation/ChatMessageRow";
import { render, screen, within } from "@solidjs/testing-library";
import { expect, test } from "vitest";

function showMessage(body: string, itemType: string) {
  const message: AgentMessage = {
    id: "message",
    author: "agent",
    kind: "text",
    body,
    itemType,
    time: "",
  };
  render(() => (
    <ChatMessageRow
      message={message}
      author={{ kind: "agent", name: "Agent" }}
      agents={[]}
      onSelectAgent={() => {}}
      onOpenLink={() => {}}
      onPreview={() => {}}
      onAttachmentAction={() => {}}
    />
  ));
  return within(screen.getByRole("article"));
}

test("renders the end of a long reply without an expand button", async () => {
  const ending = "The last paragraph of the reply.";
  const message = showMessage(`${"A complete paragraph with several words.\n\n".repeat(550)}${ending}`, "agentMessage");
  expect(await message.findByText(ending)).toBeVisible();
  expect(message.queryByRole("button", { name: /show full message/i })).toBeNull();
});

test("leaves all commentary lines available", async () => {
  const ending = "The final progress update.";
  const message = showMessage(`First update.\n\nSecond update.\n\n${ending}`, "commentary");
  const text = await message.findByText(ending);
  expect(text).toBeVisible();
  expect(text.closest("[inert]")).toBeNull();
  expect(message.queryByRole("button", { name: /show full message/i })).toBeNull();
});

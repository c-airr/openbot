/** Id suffix for a provider's reasoning stream, not a user-facing status note between tools. */
export const AGENT_REASONING_MESSAGE_ID = /:(?:reasoning|thought(?::\d+)?)$/u;

export function isAgentReasoningCommentary(message: { id: string; itemType?: string | undefined }): boolean {
  return message.itemType === "commentary" && AGENT_REASONING_MESSAGE_ID.test(message.id);
}

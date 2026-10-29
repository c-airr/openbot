/** Generic host progress lines — show in agent steps, not the activity line under the chat. */
export const GENERIC_AGENT_TOOL_PROGRESS_TEXTS = new Set([
  "A tool step failed; reviewing the result and deciding what to try next…",
  "Reviewing the latest tool result…",
  "Reviewing the sources and information I found…",
  "Searching for current information…",
  "Reviewing the information I gathered…",
  "Gathering the relevant information…",
  "Reviewing the verification results…",
  "Checking the work…",
  "Reviewing the changes I made…",
  "Making the requested changes…",
  "Reviewing the other agent’s response…",
  "Coordinating with another agent…",
  "Working through the next tool-assisted step…",
]);

export function isGenericAgentToolProgressText(text: string): boolean {
  return GENERIC_AGENT_TOOL_PROGRESS_TEXTS.has(text);
}

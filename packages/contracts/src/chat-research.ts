export const RESEARCH_COMMAND = "/research";

export function researchTopic(text: string): string | null {
  const command = /^\/research\s+([\s\S]+)$/u.exec(text.trim());
  return command?.[1]?.trim() || null;
}

export function researchDraft(text: string): string {
  const draft = text.trim();
  if (researchTopic(draft)) return draft;
  return draft && draft !== RESEARCH_COMMAND ? `${RESEARCH_COMMAND} ${draft}` : `${RESEARCH_COMMAND} `;
}

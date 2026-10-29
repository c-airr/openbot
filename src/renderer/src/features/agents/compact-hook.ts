// Fork: lets the composer call the /compact flow that agent-actions owns, with no import cycle.
export const compactHook: { run: ((agentId: string) => Promise<void>) | null } = { run: null };

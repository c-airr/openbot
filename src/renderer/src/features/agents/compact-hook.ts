// Fork: lets the composer call flows that agent-actions owns, with no import cycle.
export const compactHook: {
  run: ((agentId: string) => Promise<void>) | null;
  subagent: ((parentId: string) => Promise<void>) | null;
} = { run: null, subagent: null };

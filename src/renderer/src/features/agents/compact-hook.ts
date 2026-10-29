// Fork: lets the composer call flows that agent-actions owns, with no import cycle.
// It also tracks /compact runs that work in the background: the helper chat is
// hidden and deleted, and the parent chat shows a "compacting" notice meanwhile.
import { createSignal } from "solid-js";

export interface CompactRun {
  helperId: string;
  serverId: string;
  startedAt: number;
}

export const compactHook: {
  run: ((agentId: string) => Promise<void>) | null;
  subagent: ((parentId: string) => Promise<void>) | null;
} = { run: null, subagent: null };

const [compacting, setCompacting] = createSignal<Record<string, CompactRun>>({});

export { compacting };

export function markCompacting(parentId: string, run: CompactRun): void {
  setCompacting((current) => ({ ...current, [parentId]: run }));
}

export function clearCompacting(parentId: string): void {
  setCompacting((current) => {
    if (!(parentId in current)) return current;
    const { [parentId]: _removed, ...rest } = current;
    return rest;
  });
}

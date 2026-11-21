import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentMemorySelectionState,
  MemoryEntry,
  OpenBotDesktopApi,
  SetAgentMemoryInclusionInput,
} from "@openbot/contracts/ipc";

export interface MemoriesPort {
  ownerId: string;
  ownerLabel: string;
  ownerNoun: "agent" | "channel";
  limit: number | null;
  list: () => Promise<MemoryEntry[]>;
  selection?: {
    read: () => Promise<AgentMemorySelectionState | null>;
    set: (changes: SetAgentMemoryInclusionInput["changes"]) => Promise<AgentMemorySelectionState>;
  };
  create: (text: string) => Promise<void>;
  update: (memoryId: string, text: string) => Promise<void>;
  remove: (memoryId: string) => Promise<void>;
  clear: () => Promise<void>;
  subscribe: (reload: () => void) => () => void;
}

export type AgentMemoriesApi = Pick<
  OpenBotDesktopApi["agent"],
  | "listMemories"
  | "getMemorySelection"
  | "setMemoryInclusion"
  | "createMemory"
  | "updateMemory"
  | "deleteMemory"
  | "clearMemories"
  | "onEvent"
>;

export function agentMemoriesPort(
  agentId: string,
  agentName: string,
  limit: number | null,
  api: AgentMemoriesApi = window.openbot.agent,
): MemoriesPort {
  return {
    ownerId: agentId,
    ownerLabel: agentName,
    ownerNoun: "agent",
    limit,
    list: () => api.listMemories(agentId),
    selection: {
      read: () => api.getMemorySelection(agentId),
      set: (changes) => api.setMemoryInclusion({ agentId, changes }),
    },
    create: async (text) => {
      await api.createMemory({ agentId, text });
    },
    update: async (memoryId, text) => {
      await api.updateMemory({ agentId, memoryId, text });
    },
    remove: (memoryId) => api.deleteMemory({ agentId, memoryId }),
    clear: () => api.clearMemories(agentId),
    subscribe: (reload) =>
      api.onEvent((event) => {
        if (event.type === "memories-changed" && event.agentId === agentId) reload();
      }),
  };
}

export type ChannelMemoriesApi = Pick<
  OpenBotDesktopApi["agent"],
  | "listChannelMemories"
  | "createChannelMemory"
  | "updateChannelMemory"
  | "deleteChannelMemory"
  | "clearChannelMemories"
  | "onEvent"
>;

export function channelMemoriesPort(
  channelId: string,
  channelName: string,
  api: ChannelMemoriesApi = window.openbot.agent,
): MemoriesPort {
  return {
    ownerId: channelId,
    ownerLabel: channelName,
    ownerNoun: "channel",
    limit: INPUT_LIMITS.channelMemories,
    list: () => api.listChannelMemories(channelId),
    create: async (text) => {
      await api.createChannelMemory({ channelId, text });
    },
    update: async (memoryId, text) => {
      await api.updateChannelMemory({ channelId, memoryId, text });
    },
    remove: (memoryId) => api.deleteChannelMemory({ channelId, memoryId }),
    clear: () => api.clearChannelMemories(channelId),
    subscribe: (reload) =>
      api.onEvent((event) => {
        if (event.type === "channel-memories-changed" && event.channelId === channelId) reload();
      }),
  };
}

/**
 * Fork: the memories every chat gets. The modal reads them as an agent's named "Every chat", whose words fit.
 * shortcut: no live reload while the modal is open; a memory a chat saves meanwhile shows on the next open.
 */
export function sharedMemoriesPort(label: string): MemoriesPort {
  return {
    ownerId: "shared",
    ownerLabel: label,
    ownerNoun: "agent",
    limit: 100,
    list: () => window.openbot.listSharedMemories(),
    create: async (text) => {
      await window.openbot.saveSharedMemory({ text });
    },
    update: async (memoryId, text) => {
      await window.openbot.saveSharedMemory({ memoryId, text });
    },
    remove: (memoryId) => window.openbot.deleteSharedMemory(memoryId),
    clear: () => window.openbot.clearSharedMemories(),
    subscribe: () => () => undefined,
  };
}

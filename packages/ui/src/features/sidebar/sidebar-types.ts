import type {
  AvatarColor,
  AvatarHue,
  ChannelSummary,
  DirectThreadSummary,
  HiddenAgent,
  SidebarLayoutAction,
  SidebarLayoutSnapshot,
  TeamPresenceMember,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import type { AvatarMood } from "../../bloub-avatar";
import type { AgentProfile } from "../../data";
import type { ThreadItem } from "../conversation/threads/thread-types";
import type { ServerMenuProps } from "../servers/ServerMenu";
import type { SidebarPinnedItem } from "./sidebar-pins";

export const SIDEBAR_HIDDEN_GROUP_OPEN_ID = "hidden-agents:open";

/**
 * How the list orders the chats in the sections. Pins and "Needs you" come first in each order, and
 * none of them changes the saved `agentOrder`.
 * - `manual`: the saved order of the layout.
 * - `unread-group`: unread chats leave their section for an "Unread" group under "Needs you", and go
 *   back to their place when they are read.
 * - `unread-first`: each section shows its unread chats first, then the others, both by last
 *   activity. Chats do not drag in this order, because the order is not manual.
 * - `recent`: each section shows its chats by last activity alone, the newest conversation on top,
 *   read or not. Chats do not drag in this order either.
 *
 * Neither unread order moves a muted agent (`mutedAgentIds`): it stays in its place with its badge.
 */
export type SidebarChatOrder = "manual" | "unread-group" | "unread-first" | "recent";

export const SIDEBAR_CHAT_ORDERS = [
  "manual",
  "recent",
  "unread-group",
  "unread-first",
] as const satisfies readonly SidebarChatOrder[];

export const SIDEBAR_CHAT_ORDER_LABEL = {
  manual: "sidebar.order.manual",
  recent: "sidebar.order.recent",
  "unread-group": "sidebar.order.unreadGroup",
  "unread-first": "sidebar.order.unreadFirst",
} as const satisfies Record<SidebarChatOrder, AppTextKey>;

export function sidebarChatOrderSortsSections(order: SidebarChatOrder | undefined): boolean {
  return order === "recent" || order === "unread-first";
}

export interface SidebarProps {
  deleteSupported?: boolean | undefined;
  marketplaceSupported?: boolean | undefined;
  channels?: ChannelSummary[] | undefined;
  deletedChannels?: ChannelSummary[] | undefined;
  activeChannelId?: string | null | undefined;
  onSelectChannel?: ((channelId: string) => void) | undefined;
  showingArchivedChannels?: boolean | undefined;
  onToggleArchivedChannels?: (() => void) | undefined;
  onCreateChannel?: (() => void) | undefined;
  onMarkAllRead?: (() => void) | undefined;
  hasUnread?: boolean | undefined;
  onEditChannel?: ((channelId: string) => void) | undefined;
  onDeleteChannel?: ((channelId: string) => Promise<void>) | undefined;
  onRestoreChannel?: ((channelId: string) => void) | undefined;
  serverName: string;
  onOpenServerSettings?: ((trigger: HTMLElement) => void) | undefined;
  serverMenu?: Omit<ServerMenuProps, "serverName" | "compact"> | undefined;
  chatHistory?: SidebarChatHistory | undefined;
  serverUpdate?: { version: string; running: boolean; onOpen: () => void } | undefined;
  topbarDetail?: JSX.Element | undefined;
  agents: AgentProfile[];
  activeAgentId: string;
  showPeople?: boolean | undefined;
  people: TeamPresenceMember[];
  directThreads: DirectThreadSummary[];
  activeDirectMemberId: string | null;
  agentStates: Record<string, SidebarAgentState>;
  channelWaits?: Record<string, SidebarChannelWait> | undefined;
  channelPreviewsPending?: boolean | undefined;
  agentMoods: Record<string, AvatarMood>;
  layout: SidebarLayoutSnapshot;
  layoutMutable?: boolean | undefined;
  chatOrder?: SidebarChatOrder | undefined;
  onChatOrderChange?: ((order: SidebarChatOrder) => void) | undefined;
  collapsedSectionIds: string[];
  onMutateLayout: (action: SidebarLayoutAction) => Promise<void>;
  foldersSupported?: boolean | undefined;
  sectionDuplicateSupported?: boolean | undefined;
  duplicatingSectionIds?: ReadonlySet<string> | undefined;
  onDuplicateSection?: ((sectionId: string) => Promise<void>) | undefined;
  onToggleSection: (sectionId: string) => void;
  pinnedItems: SidebarPinnedItem[];
  peopleOrder: string[];
  onPin: (item: SidebarPinnedItem) => void;
  onUnpin: (item: SidebarPinnedItem) => void;
  onReorderPinned: (items: SidebarPinnedItem[]) => void;
  onReorderPeople: (memberIds: string[]) => void;
  onSelectAgent: (agentId: string) => void;
  onSelectPerson: (memberId: string) => void;
  onPreloadDirectConversation?: (() => void) | undefined;
  createSupported?: boolean | undefined;
  onCreateAgent: () => void;
  /** Starts an empty chat at once, in the default project folder when one is set. */
  onCreateChat?: (() => void) | undefined;
  /** Asks for a project folder, remembers it as the default, and starts an empty chat in it. */
  onCreateChatInFolder?: (() => void) | undefined;
  /** Opens the list of sessions that other coding apps keep on this computer. */
  onImportSessions?: (() => void) | undefined;
  /** Opens the memories that every chat gets. */
  onOpenSharedMemory?: (() => void) | undefined;
  onEditAgent: (agentId: string) => void;
  duplicateSupported?: boolean | undefined;
  duplicatingAgentIds?: ReadonlySet<string> | undefined;
  onDuplicateAgent?: ((agentId: string) => Promise<void>) | undefined;
  onDeleteAgent: (agentId: string) => Promise<void>;
  userHiddenAgents?: HiddenAgent[] | undefined;
  userHiddenAgentsWork?: boolean | undefined;
  unreadAgentIds?: ReadonlySet<string> | undefined;
  onMarkAgentRead?: ((agentId: string) => void) | undefined;
  onMarkAgentUnread?: ((agentId: string) => void) | undefined;
  mutedAgentIds?: ReadonlySet<string> | undefined;
  onSetAgentMuted?: ((agentId: string, muted: boolean) => void) | undefined;
  /** Fork: interrupts the turn that an agent runs, whichever agent is open. */
  onStopAgent?: ((agentId: string) => void) | undefined;
  /** Hides an agent. Without it, the agent menu shows no hide item. */
  onHideAgent?: ((agentId: string) => void) | undefined;
  onRestoreAgent?: ((agentId: string) => void) | undefined;
  onNewAgentThread?: ((agentId: string) => void) | undefined;
  agentThreads?: SidebarAgentThreads | undefined;
  onOpenAgentWindow?: ((agentId: string) => void) | undefined;
  windowAgentIds?: ReadonlySet<string> | undefined;
  compact: boolean;
  footer?: JSX.Element;
  onExpand: () => void;
  onCollapse?: (() => void) | undefined;
  onOpenSearch: () => void;
  onOpenMarketplace: () => void;
  agentsConnecting?: boolean | undefined;
  emptyAction?:
    | {
        label: string;
        avatarSeed: string;
        avatarHue: AvatarHue | null;
        avatarColor: AvatarColor | null;
        onSelect: () => void;
      }
    | undefined;
}

export interface SidebarAgentThreads {
  threads: (agentId: string) => readonly ThreadItem[];
  openId: (agentId: string) => string | undefined;
  load: (agentId: string) => void;
  onOpen: (agentId: string, threadId: string) => void;
  onNew?: ((agentId: string) => void) | undefined;
}

export interface SidebarChatHistory {
  back: { name: string } | null;
  forward: { name: string } | null;
  keys: { back: string; forward: string };
  onBack: () => void;
  onForward: () => void;
}

export type SidebarRoutinePhase = "running" | "queued" | "failed";

export type SidebarWaitReason = "question" | "approval" | "takeover";

export type SidebarAgentState =
  | { kind: "waiting"; reason: SidebarWaitReason; detail: string | null }
  | { kind: "working" }
  | { kind: "responded" }
  | { kind: "unread"; count: number }
  | { kind: "routine"; phase: SidebarRoutinePhase; count: number }
  | { kind: "limited"; resetsAt: number | null };

export type SidebarChannelWait = Extract<SidebarAgentState, { kind: "waiting" }>;

export type ResolvedPinnedItem = { ref: SidebarPinnedItem; chat: SidebarChatItem };

export type SidebarChatItem =
  | { kind: "agent"; id: string; agent: AgentProfile }
  | { kind: "channel"; id: string; channel: ChannelSummary };

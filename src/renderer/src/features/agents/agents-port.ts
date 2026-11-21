import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export interface AgentsPort {
  agent: Pick<
    OpenBotDesktopApi["agent"],
    | "createAgent"
    | "deleteAgent"
    | "duplicateAgent"
    | "getAgentAdminSettings"
    | "getAgentHostSettings"
    | "updateAgentHostSettings"
    | "getAgentBackupModels"
    | "updateAgentBackupModels"
    | "getAgentNewChat"
    | "updateAgentNewChat"
    | "getAgentPlanCard"
    | "updateAgentPlanCard"
    | "getAgentBuiltinMemory"
    | "updateAgentBuiltinMemory"
    | "getAgentFastMode"
    | "updateAgentFastMode"
    | "listAgents"
    | "listConversationReads"
    | "listModels"
    | "onEvent"
    | "getRuntimeSnapshot"
    | "listPendingPrompts"
    | "setAgentHidden"
    | "archiveInactiveAgents"
    | "setAgentNotificationLevel"
    | "setAvatar"
    | "updateAgent"
    | "updateAgentAdminSettings"
  >;
  providerAdmin: Pick<OpenBotDesktopApi["providerAdmin"], "accounts" | "accountUsage">;
  /** Fork: asks for a project folder. */
  chooseFolder: OpenBotDesktopApi["chooseFolder"];
  /** Fork: the sessions other coding apps keep on this computer, and the chats made from them. */
  listImportableSessions: OpenBotDesktopApi["listImportableSessions"];
  importSessions: OpenBotDesktopApi["importSessions"];
}

export function agentsPort(): AgentsPort {
  return window.openbot;
}

import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the agents domain reaches in main: agent records, their models and read state, and the agent
 * event stream.
 */
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
    | "getAgentTaskLimit"
    | "updateAgentTaskLimit"
    | "listAgents"
    | "listConversationReads"
    | "listModels"
    | "onEvent"
    | "getRuntimeSnapshot"
    | "setAgentHidden"
    | "archiveInactiveAgents"
    | "setAvatar"
    | "updateAgent"
    | "updateAgentAdminSettings"
  >;
  /** The accounts of a joined server's providers, which its released agent routes do not carry. */
  providerAdmin: Pick<OpenBotDesktopApi["providerAdmin"], "accounts" | "accountUsage">;
  /** Fork: asks for a project folder. */
  chooseFolder: OpenBotDesktopApi["chooseFolder"];
  /** Fork: the sessions other coding apps keep on this computer, and the chats made from them. */
  listImportableSessions: OpenBotDesktopApi["listImportableSessions"];
  importSessions: OpenBotDesktopApi["importSessions"];
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function agentsPort(): AgentsPort {
  return window.openbot;
}

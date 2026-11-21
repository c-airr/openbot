import { type ApplySessionImportInput, type ClientAgentSummary, CONTEXT_RESET_ITEM_TYPE } from "@openbot/contracts/ipc";
import { AGENT_WELCOME_CAPABILITY, TEAM_AGENT_CREATE_MODEL_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { classifyFailure } from "@openbot/telemetry";
import { toast } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import {
  AGENT_DELETE_UNDO_MS,
  AgentDeleteUndoToast,
  startUndoCountdown,
  type UndoCountdown,
} from "@openbot/ui/features/agents/AgentDeleteUndoToast";
import type { FirstAgentDraft } from "@openbot/ui/features/agents/FirstAgentSetup";
import { duplicateSection as duplicateSectionWith } from "@openbot/ui/features/sidebar/duplicate-section";
import { currentText } from "@openbot/ui/text";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import { desktopAnalytics } from "../../analytics";
import { toAgentProfile, withoutAgent } from "../../app-message-projection";
import { createStoredProfile } from "../../app-stored-values";
import { useNavigation } from "../../navigation";
import { usePlatform } from "../../platform";
import { createScopeGuard } from "../../scope-lifetime";
import { createSimpleContext } from "../../simple-context";
import { useTurns } from "../../turns";
import { useAgentThreads } from "../agent-threads/agent-threads-context";
import { useConversation } from "../conversation/conversation-context";
import { useConversationController } from "../conversation/conversation-controller-context";
import { agentConversationKey, composerDraftKey } from "../conversation/conversation-keys";
import { conversationPort } from "../conversation/conversation-port";
import { useDirectMessages } from "../conversation/direct-messages-context";
import { useServers } from "../servers/servers-context";
import { useSidebar } from "../sidebar/sidebar-context";
import { type NewAgentDraft, newAgentInput } from "./agent-create-input";
import { attentionAgentId, withoutAttention } from "./agent-runtime-snapshot";
import { useAgents } from "./agents-context";
import { agentsPort } from "./agents-port";
import { type CompactRun, clearCompacting, compactHook, compacting, markCompacting } from "./compact-hook";
import { cheapestCompactModel } from "./compact-model";
import { forgetPendingAgentDelete, readPendingAgentDeletes, rememberPendingAgentDelete } from "./pending-agent-deletes";

/**
 * Creating, editing, duplicating and deleting an agent.
 *
 * A leaf, and it has to be one: `deleteAgent` alone writes to agents,
 * conversation, turns, sidebar and navigation, so no domain can own it without
 * reaching into one nested under itself. This is the shape the dependency rule
 * pushes every multi-domain command into - state lives outward, the command
 * that spans several domains lives at the bottom and reads all of them.
 *
 * The four share one guard, `agentSetupOpen() && creatingAgent()`: while the
 * first-agent form is mid-submit there is no agent to act on yet, and letting a
 * second write through would race the one in flight.
 *
 * Conversation cleanup belongs to its domain. This command removes the agent
 * and asks each domain to remove the state that it owns.
 */
/** The longest chat name taken from the first message. */
const CHAT_NAME_LENGTH = 48;

const AgentActions = createSimpleContext({
  name: "Agent actions",
  init: () => {
    const { activeServer, activeServerId, activeServerSupportsCapability } = useServers();
    const scopeIsCurrent = createScopeGuard();
    const {
      agentList,
      modelOptions,
      agentListSettled,
      setAgentList,
      agentSetupOpen,
      setAgentSetupOpen,
      openAgentSetup,
      agentSetupDraft,
      setAgentSetupError,
      creatingAgent,
      setCreatingAgent,
      duplicatingAgentIds,
      setDuplicatingAgentIds,
      activeAgentId,
      setActiveAgentId,
      setSettingsRequest,
      setUiErrors,
      analyticsAgentProperties,
      hideAgent,
      forgetHiddenAgent,
      userHiddenAgents,
      userHiddenAgentIds,
      applyUserHiddenAgents,
      ownAgentLevels,
      applyOwnAgentLevels,
    } = useAgents();
    const { initializeConversation, removeConversation } = useConversation();
    const { conversationErrors } = useConversationController();
    const threads = useAgentThreads();
    const { activeTurns, failedTurns, setActiveTurns, setFailedTurns, setQueues, setPendingPrompts } = useTurns();
    const { sidebarLayout, setSidebarLayout, applySidebarLayoutAction, removePinnedSidebarItemEverywhere } =
      useSidebar();
    const { selectAgent, openCreatedAgent } = useNavigation();
    const { clearDirectSelection } = useDirectMessages();
    const [duplicatingSectionIds, setDuplicatingSectionIds] = createSignal<Set<string>>(new Set());

    const createModelSupported = () =>
      activeServer()?.kind !== "remote" || activeServerSupportsCapability(TEAM_AGENT_CREATE_MODEL_CAPABILITY);
    const welcomeSupported = () =>
      activeServer()?.kind !== "remote" || activeServerSupportsCapability(AGENT_WELCOME_CAPABILITY);

    /** Asks the host for the agent. */
    function requestNewAgent(draft: NewAgentDraft) {
      return agentsPort().agent.createAgent(newAgentInput(draft, createModelSupported(), welcomeSupported()));
    }

    function addNewAgent(stored: ClientAgentSummary): AgentProfile {
      const newAgent = createStoredProfile(toAgentProfile(stored));
      setAgentList((current) => [newAgent, ...current.filter((item) => item.id !== newAgent.id)]);
      initializeConversation(newAgent.id);
      return newAgent;
    }

    async function createAgent(draft: FirstAgentDraft = agentSetupDraft()) {
      if (creatingAgent()) return;
      const analytics = desktopAnalytics.scope();
      const submitted = { ...draft };
      setCreatingAgent(true);
      setAgentSetupError(null);
      try {
        const newAgent = addNewAgent(await requestNewAgent(submitted));
        openCreatedAgent(newAgent.id);
        const properties = analyticsAgentProperties(newAgent.id);
        analytics.track("agent_action", { action: "create", result: "succeeded", ...(properties ?? {}) });
      } catch (error) {
        analytics.track("agent_action", { action: "create", result: "failed", failure_code: "create_failed" });
        const { t, errorMessage } = currentText();
        setAgentSetupError(errorMessage(error, t("agent.error.createFailed")));
      } finally {
        setCreatingAgent(false);
      }
    }

    /**
     * Fork: a chat is an agent whose first message is the user's own, named after that message and
     * put in the Chats section. A failed move leaves it in the default section.
     */
    async function createChat(draft: FirstAgentDraft = agentSetupDraft(), folder?: string) {
      const message = draft.purpose.trim();
      if (creatingAgent()) return;
      setCreatingAgent(true);
      setAgentSetupError(null);
      try {
        // An empty chat is named after its folder, or "New chat"; the first message is the user's to type.
        const name = message
          ? (message.split("\n")[0] ?? "").slice(0, CHAT_NAME_LENGTH).trim()
          : ((folder ?? "").split(/[\\/]/u).filter(Boolean).pop() ?? currentText().t("sidebar.new.chat"));
        const input = newAgentInput({ ...draft, name, purpose: "Chat" }, createModelSupported(), welcomeSupported());
        const newAgent = addNewAgent(
          await agentsPort().agent.createAgent({
            ...input,
            initialMessage: message,
            showInitialMessage: true,
            ...(message ? {} : { blank: true }),
            ...(folder ? { workspaceFolder: folder } : {}),
          }),
        );
        setAgentSetupOpen(false);
        clearDirectSelection();
        setActiveAgentId(newAgent.id);
        const sectionName = currentText().t("agent.chat.section");
        const section = sidebarLayout().sections.find(
          (item) => item.name === sectionName || item.name === "Chats" || item.name === "Czaty",
        );
        void applySidebarLayoutAction(
          section
            ? { type: "assign", agentId: newAgent.id, sectionId: section.id }
            : { type: "create", name: sectionName, agentId: newAgent.id },
        ).catch(() => undefined);
      } catch (error) {
        const { t, errorMessage } = currentText();
        setAgentSetupError(errorMessage(error, t("agent.error.createFailed")));
      } finally {
        setCreatingAgent(false);
      }
    }

    /** Fork: the folder that new chats work in. Per viewer, so it is browser storage, not host state. */
    const CHAT_FOLDER_KEY = "openbot-fork-chat-folder";
    function defaultChatFolder(): string | undefined {
      try {
        return localStorage.getItem(CHAT_FOLDER_KEY) ?? undefined;
      } catch {
        return undefined;
      }
    }

    // The folder shows on the start screen, so the user sees where the next chat will work.
    const [chatFolder, setChatFolder] = createSignal<string | undefined>(defaultChatFolder());
    function rememberChatFolder(folder: string | undefined) {
      setChatFolder(folder);
      try {
        if (folder) localStorage.setItem(CHAT_FOLDER_KEY, folder);
        else localStorage.removeItem(CHAT_FOLDER_KEY);
      } catch {
        // Without storage the choice lasts until the app closes.
      }
    }
    async function chooseChatFolder() {
      const folder = await agentsPort().chooseFolder();
      if (folder) rememberChatFolder(folder);
    }

    /** Fork: the chat from the start screen, made on its first message, in the chosen folder when one is set. */
    function startChat(draft: FirstAgentDraft = agentSetupDraft()) {
      return createChat(draft, chatFolder());
    }

    /**
     * Fork: an empty subagent of the open chat. It goes to the Subagents section, and its description
     * carries "parent:<id>", which lets it read the parent chat (see developerInstructions).
     */
    async function startSubagent(parentId: string) {
      if (creatingAgent()) return;
      setCreatingAgent(true);
      try {
        const { t } = currentText();
        const input = newAgentInput(
          { ...agentSetupDraft(), name: t("sidebar.new.subagent"), purpose: "Chat" },
          createModelSupported(),
          welcomeSupported(),
        );
        const newAgent = addNewAgent(
          await agentsPort().agent.createAgent({
            ...input,
            initialMessage: "",
            blank: true,
            ...(parentId ? { description: `parent:${parentId}` } : {}),
          }),
        );
        clearDirectSelection();
        setActiveAgentId(newAgent.id);
        const sectionName = t("agent.subagent.section");
        const section = sidebarLayout().sections.find(
          (item) => item.name === sectionName || item.name === "Subagents" || item.name === "Subagenci",
        );
        void applySidebarLayoutAction(
          section
            ? { type: "assign", agentId: newAgent.id, sectionId: section.id }
            : { type: "create", name: sectionName, agentId: newAgent.id },
        ).catch(() => undefined);
      } catch (error) {
        const { t, errorMessage } = currentText();
        setAgentSetupError(errorMessage(error, t("agent.error.createFailed")));
      } finally {
        setCreatingAgent(false);
      }
    }

    /**
     * Fork: /compact. A hidden helper chat on the cheapest model that has room reads this chat
     * through the parent tools and hands over a briefing (apply_compact). This chat then starts
     * again from the briefing, in the same chat, with a "Session compacted" marker. The user never
     * sees the helper: it is hidden at once and deleted when it is done, and the parent chat shows
     * a "compacting" notice meanwhile (see the compact watcher below). The marker carries the
     * briefing, so the user can open and copy it there.
     */
    async function compactChat(agentId: string) {
      if (creatingAgent()) return;
      if (compacting()[agentId]) {
        actionToast.warning(currentText().t("composer.compact.running"));
        return;
      }
      const parent = agentList().find((candidate) => candidate.id === agentId);
      if (!parent) return;
      const serverId = activeServerId();
      setCreatingAgent(true);
      try {
        const usage = await agentsPort()
          .providerAdmin.accountUsage(serverId)
          .catch(() => null);
        if (!scopeIsCurrent() || activeServerId() !== serverId) return;
        const cheap = cheapestCompactModel(modelOptions(), usage);
        const { t } = currentText();
        if (!cheap) {
          actionToast.error(t("composer.compact.failed"), {
            description: t("composer.compact.noModel"),
          });
          return;
        }
        const input = newAgentInput(
          {
            ...agentSetupDraft(),
            name: `${t("sidebar.compact.prefix")} ${parent.name}`.slice(0, CHAT_NAME_LENGTH),
            purpose: "Chat",
          },
          createModelSupported(),
          welcomeSupported(),
        );
        const { provider: _p, model: _m, reasoningEffort: _r, ...safeInput } = input;
        const startedAt = Date.now();
        const helper = addNewAgent(
          await agentsPort().agent.createAgent(
            {
              ...safeInput,
              provider: cheap.model.provider,
              model: cheap.model.id,
              ...(cheap.reasoningEffort ? { reasoningEffort: cheap.reasoningEffort } : {}),
              // "compact:<start>" lets the hidden helper run its queue and makes a late briefing refused.
              description: `compact:${startedAt} parent:${agentId}`,
              initialMessage:
                "Compact the parent chat. Read all of it with openbot.parent_history_read, page by page, newest first. Then write one briefing that another AI model can continue from: the goal, decisions made, the current state, files and commands that matter, open tasks, and the user's preferences. Be concrete and keep it under 1500 words. Do not write the briefing in this chat: pass it to openbot.apply_compact as summary, once. Then answer with one short line.",
            },
            serverId,
          ),
        );
        // No sidebar section: the helper stays out of every section, and it is hidden at once so
        // the user never sees it, not even in the Hidden group.
        try {
          const snapshot = await agentsPort().agent.setAgentHidden({ agentId: helper.id, hidden: true }, serverId);
          applyUserHiddenAgents(snapshot.agents);
        } catch {
          // The watcher still deletes the helper when it is done; it only stays visible until then.
        }
        markCompacting(agentId, { helperId: helper.id, serverId, startedAt });
        actionToast.success(t("composer.compact.started", { model: cheap.model.name }));
      } catch (error) {
        const { t, errorMessage } = currentText();
        actionToast.error(t("composer.compact.failed"), {
          description: errorMessage(error, t("agent.error.createFailed")),
        });
      } finally {
        setCreatingAgent(false);
      }
    }
    compactHook.run = compactChat;
    compactHook.subagent = startSubagent;

    /**
     * Fork: the /compact background watcher. Every few seconds it reads the latest page of each
     * compacting chat. A fresh context-reset marker means the helper applied its briefing, so the
     * run ends as done at once: the helper's closing line is not needed. A finished or failed
     * helper answer without a marker means it failed (usually the chat was busy, so the reset was
     * refused). A helper with no turn and no output after a while never started (bad model, spent
     * quota), so the run fails fast instead of hanging until the timeout. Either way the helper is
     * deleted and the notice goes away. A run that hears nothing for a while is dropped the same way.
     */
    const COMPACT_POLL_MS = 5000;
    const COMPACT_TIMEOUT_MS = 15 * 60 * 1000;
    const COMPACT_IDLE_MS = 3 * 60 * 1000;
    const compactTimer = window.setInterval(() => void pollCompactRuns(), COMPACT_POLL_MS);
    onCleanup(() => window.clearInterval(compactTimer));

    async function pollCompactRuns() {
      const parentIds = Object.keys(compacting());
      if (parentIds.length === 0) return;
      for (const parentId of parentIds) {
        const run = compacting()[parentId];
        if (!run || run.serverId !== activeServerId()) continue;
        try {
          const helperPage = await conversationPort()
            .agent.readConversationPage({ agentId: run.helperId, anchor: { type: "latest" }, limit: 5 }, run.serverId)
            .catch(() => null);
          const parentPage = await conversationPort()
            .agent.readConversationPage({ agentId: parentId, anchor: { type: "latest" }, limit: 10 }, run.serverId)
            .catch(() => null);
          const marked = parentPage?.messages.some(
            (message) =>
              message.itemType === CONTEXT_RESET_ITEM_TYPE &&
              message.status === "completed" &&
              Date.parse(message.createdAt) >= run.startedAt,
          );
          if (marked) {
            await finishCompactRun(parentId, run, true);
            continue;
          }
          const helperMessages = (helperPage?.messages ?? []).filter(
            (message) => message.author === "assistant" && Date.parse(message.createdAt) >= run.startedAt,
          );
          // Only the final answer ends the helper: its thinking notes are complete messages too.
          const helperDone = helperMessages.some(
            (message) => message.itemType === "final_answer" && message.status !== "streaming",
          );
          const elapsed = Date.now() - run.startedAt;
          const helperWorking = helperMessages.length > 0 || (activeTurns()[run.helperId] ?? null) !== null;
          // The marker is written before the helper answers, so a finished helper without one failed.
          if (
            elapsed > COMPACT_TIMEOUT_MS ||
            (parentPage && (helperDone || failedTurns()[run.helperId])) ||
            (parentPage && !helperWorking && elapsed > COMPACT_IDLE_MS)
          )
            await finishCompactRun(parentId, run, false);
        } catch {
          // The next tick tries again; the timeout bounds the wait.
        }
      }
    }

    /** Fork: ends one /compact run: the helper is deleted and the parent notice goes away. */
    async function finishCompactRun(parentId: string, run: CompactRun, ok: boolean) {
      if (compacting()[parentId] !== run) return;
      const description = conversationErrors()[composerDraftKey({ agentId: run.helperId, serverId: run.serverId })];
      clearCompacting(parentId);
      try {
        await agentsPort().agent.deleteAgent(run.helperId, run.serverId);
      } catch {
        // A helper whose turn still runs refuses the delete; it stays hidden.
      }
      if (scopeIsCurrent() && activeServerId() === run.serverId) {
        setAgentList((current) => current.filter((candidate) => candidate.id !== run.helperId));
        threads.forgetAgent(run.helperId);
        removeConversation(run.helperId);
      }
      const { t } = currentText();
      if (ok) actionToast.success(t("composer.compact.done"));
      else actionToast.error(t("composer.compact.failed"), description ? { description } : undefined);
    }

    async function startChatInFolder() {
      const folder = await agentsPort().chooseFolder();
      if (!folder) return;
      rememberChatFolder(folder);
      openAgentSetup("chat");
    }

    /**
     * Fork: chats made from the sessions of other apps. Each goes to the Chats section, and a single
     * one opens at once; several stay in the list for the user to open.
     */
    async function importSessions(input: ApplySessionImportInput) {
      const result = await agentsPort().importSessions(input);
      const sectionName = currentText().t("agent.chat.section");
      for (const agentId of result.agentIds) {
        const section = sidebarLayout().sections.find(
          (item) => item.name === sectionName || item.name === "Chats" || item.name === "Czaty",
        );
        await applySidebarLayoutAction(
          section ? { type: "assign", agentId, sectionId: section.id } : { type: "create", name: sectionName, agentId },
        ).catch(() => undefined);
      }
      const [only] = result.agentIds;
      if (only && result.agentIds.length === 1) selectAgent(only);
      return result;
    }

    function editAgent(agentId: string) {
      if (agentSetupOpen() && creatingAgent()) return;
      selectAgent(agentId);
      setSettingsRequest({ agentId, nonce: Date.now() });
    }

    async function copyAgent(agentId: string) {
      const result = await agentsPort().agent.duplicateAgent(agentId);
      if (!scopeIsCurrent()) return null;
      const profile = createStoredProfile(toAgentProfile(result.agent));
      setAgentList((current) => [profile, ...current.filter((candidate) => candidate.id !== profile.id)]);
      setSidebarLayout(result.layout);
      return result;
    }

    async function duplicateAgent(agentId: string): Promise<void> {
      if (agentSetupOpen() && creatingAgent()) return;
      if (!activeServerSupportsCapability("agent-duplication") || duplicatingAgentIds().has(agentId)) return;
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(agentId);
      setDuplicatingAgentIds((current) => new Set(current).add(agentId));
      try {
        const result = await copyAgent(agentId);
        if (!result) return;
        selectAgent(result.agent.id);
        analytics.track("agent_action", { action: "duplicate", result: "succeeded", ...(properties ?? {}) });
      } catch (error) {
        analytics.track("agent_action", {
          action: "duplicate",
          result: "failed",
          failure_code: "duplicate_failed",
          ...(properties ?? {}),
        });
        const { t, errorMessage } = currentText();
        actionToast.error(t("agent.error.duplicateTitle"), {
          ...{
            description: errorMessage(error, t("agent.error.duplicateFailed")),
          },
          report: { operation: "agent", source: "action", cause_code: classifyFailure(error) },
        });
        throw error;
      } finally {
        setDuplicatingAgentIds((current) => {
          const next = new Set(current);
          next.delete(agentId);
          return next;
        });
      }
    }

    async function duplicateSection(sectionId: string): Promise<void> {
      if (agentSetupOpen() && creatingAgent()) return;
      if (!activeServerSupportsCapability("agent-duplication") || !activeServerSupportsCapability("sidebar-layout")) {
        return;
      }
      if (duplicatingSectionIds().has(sectionId)) return;
      setDuplicatingSectionIds((current) => new Set(current).add(sectionId));
      try {
        const hidden = userHiddenAgentIds();
        await duplicateSectionWith(
          {
            layout: sidebarLayout(),
            agentIds: agentList()
              .filter((agent) => !hidden.has(agent.id))
              .map((agent) => agent.id),
            duplicateAgent: async (agentId) => {
              if (!scopeIsCurrent()) return null;
              setDuplicatingAgentIds((current) => new Set(current).add(agentId));
              try {
                const result = await copyAgent(agentId);
                return result && { agentId: result.agent.id, layout: result.layout };
              } finally {
                setDuplicatingAgentIds((current) => {
                  const next = new Set(current);
                  next.delete(agentId);
                  return next;
                });
              }
            },
            mutateLayout: async (action) => {
              if (!scopeIsCurrent()) return null;
              const layout = await applySidebarLayoutAction(action);
              return scopeIsCurrent() ? layout : null;
            },
          },
          sectionId,
        );
      } catch (error) {
        const { t, errorMessage } = currentText();
        actionToast.error(t("sidebar.section.duplicateTitle"), {
          description: errorMessage(error, t("sidebar.section.duplicateFailed")),
          report: { operation: "agent", source: "action", cause_code: classifyFailure(error) },
        });
        throw error;
      } finally {
        setDuplicatingSectionIds((current) => {
          const next = new Set(current);
          next.delete(sectionId);
          return next;
        });
      }
    }

    const pendingDeletes = new Map<string, () => void>();
    onCleanup(() => {
      for (const commit of [...pendingDeletes.values()]) commit();
    });

    let pendingDeletesResumed = Boolean(usePlatform().chatWindow);
    createEffect(
      () => (!pendingDeletesResumed && agentListSettled() ? agentList().map((agent) => agent.id) : null),
      (listedIds) => {
        if (!listedIds || pendingDeletesResumed) return;
        pendingDeletesResumed = true;
        const serverId = untrack(activeServerId);
        for (const [agentId, savedAt] of Object.entries(readPendingAgentDeletes(serverId))) {
          if (!listedIds.includes(agentId)) {
            forgetPendingAgentDelete(serverId, agentId);
            continue;
          }
          const resume = () => {
            if (scopeIsCurrent() && readPendingAgentDeletes(serverId)[agentId] === savedAt)
              void deleteAgent(agentId, true);
          };
          window.setTimeout(resume, Math.max(0, savedAt + AGENT_DELETE_UNDO_MS - Date.now()));
        }
      },
    );

    async function deleteAgent(agentId: string, resumed = false) {
      if (agentSetupOpen() && creatingAgent()) return;
      if (pendingDeletes.has(agentId)) return;
      const agent = agentList().find((candidate) => candidate.id === agentId);
      if (!agent) return;
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(agentId);
      const marketplaceAgent = Boolean(agent.marketplaceSource);
      const wasActive = activeAgentId() === agentId;
      const others = agentList().filter((candidate) => candidate.id !== agentId);
      const userHidden = userHiddenAgentIds();
      const nextAgentId = (others.find((candidate) => !userHidden.has(candidate.id)) ?? others[0])?.id ?? "";
      const hidden = hideAgent(agentId);
      if (!hidden) return;
      const showAgent: () => void = hidden;
      if (wasActive) setActiveAgentId(nextAgentId);
      setSettingsRequest((current) => (current?.agentId === agentId ? null : current));
      rememberPendingAgentDelete(serverId, agentId);

      const toastId = `agent-delete-${serverId}-${agentId}`;
      let settled = false;
      let countdown: UndoCountdown | null = null;
      function settle(): boolean {
        if (settled) return false;
        settled = true;
        countdown?.stop();
        pendingDeletes.delete(agentId);
        queueMicrotask(() => toast.dismiss(toastId));
        return true;
      }

      function undo(): void {
        if (!settle()) return;
        forgetPendingAgentDelete(serverId, agentId);
        if (!scopeIsCurrent()) return;
        showAgent();
        if (wasActive) setActiveAgentId(agentId);
      }

      function forgetDeletedAgent(): void {
        analytics.track("agent_action", { action: "delete", result: "succeeded", ...(properties ?? {}) });
        if (marketplaceAgent) {
          analytics.track("marketplace_action", { entity: "agent", action: "uninstall", result: "succeeded" });
        }
        if (!scopeIsCurrent()) return;
        forgetHiddenAgent(agentId);
        threads.forgetAgent(agentId);
        removeConversation(agentId);
        setUiErrors((current) => withoutAgent(current, agentConversationKey(serverId, agentId)));
        setActiveTurns((current) => withoutAgent(current, agentId));
        setFailedTurns((current) => withoutAgent(current, agentId));
        setQueues((current) => withoutAgent(current, agentId));
        setPendingPrompts((current) => withoutAttention(current, (event) => attentionAgentId(event) === agentId));
      }

      async function commit(): Promise<void> {
        if (!settle()) return;
        removePinnedSidebarItemEverywhere({ kind: "agent", id: agentId });
        try {
          await agentsPort().agent.deleteAgent(agentId, serverId);
          forgetDeletedAgent();
        } catch (error) {
          const stillListed = await agentsPort()
            .agent.listAgents(serverId)
            .then(
              (agents) => agents.some((candidate) => candidate.id === agentId),
              () => true,
            );
          if (!stillListed) {
            forgetDeletedAgent();
            return;
          }
          analytics.track("agent_action", {
            action: "delete",
            result: "failed",
            failure_code: "delete_failed",
            ...(properties ?? {}),
          });
          if (marketplaceAgent) {
            analytics.track("marketplace_action", {
              entity: "agent",
              action: "uninstall",
              result: "failed",
              failure_code: "uninstall_failed",
            });
          }
          if (scopeIsCurrent()) showAgent();
          const { t, errorMessage } = currentText();
          actionToast.error(t("agent.error.deleteFailed"), {
            description: errorMessage(error, t("sidebar.delete.failed")),
            report: { operation: "agent", source: "action", cause_code: classifyFailure(error) },
          });
        } finally {
          forgetPendingAgentDelete(serverId, agentId);
        }
      }

      if (resumed) {
        void commit();
        return;
      }
      const undoCountdown = startUndoCountdown(() => void commit());
      countdown = undoCountdown;
      pendingDeletes.set(agentId, () => void commit());
      toast(() => <AgentDeleteUndoToast agent={agent} countdown={undoCountdown} onUndo={undo} />, {
        id: toastId,
        duration: Number.POSITIVE_INFINITY,
        unstyled: true,
        closeButton: false,
        class: "agent-delete-undo-toast-host",
        onDismiss: () => void commit(),
      });
    }

    const hideToastIds = new Set<string>();
    onCleanup(() => {
      const ids = [...hideToastIds];
      queueMicrotask(() => {
        for (const id of ids) toast.dismiss(id);
      });
    });

    async function setAgentHiddenByUser(agentId: string, hidden: boolean): Promise<void> {
      if (agentSetupOpen() && creatingAgent()) return;
      const agent = agentList().find((candidate) => candidate.id === agentId);
      if (!agent || userHiddenAgentIds().has(agentId) === hidden) return;
      const serverId = activeServerId();
      const toastId = `agent-hide-${serverId}-${agentId}`;
      const previous = userHiddenAgents().find((entry) => entry.agentId === agentId);
      const withoutAgent = () => userHiddenAgents().filter((entry) => entry.agentId !== agentId);
      applyUserHiddenAgents(
        hidden ? [...withoutAgent(), { agentId, hiddenAt: new Date().toISOString() }] : withoutAgent(),
      );
      if (hidden) {
        const { t } = currentText();
        hideToastIds.add(toastId);
        toast(t("agent.hideUndo.title", { name: agent.name }), {
          id: toastId,
          action: { label: t("agent.hideUndo.action"), onClick: () => void setAgentHiddenByUser(agentId, false) },
          onDismiss: () => hideToastIds.delete(toastId),
          onAutoClose: () => hideToastIds.delete(toastId),
        });
      } else if (hideToastIds.delete(toastId)) {
        toast.dismiss(toastId);
      }
      try {
        const snapshot = await agentsPort().agent.setAgentHidden({ agentId, hidden }, serverId);
        applyUserHiddenAgents(snapshot.agents);
      } catch (error) {
        if (!scopeIsCurrent()) return;
        applyUserHiddenAgents(previous ? [...withoutAgent(), previous] : withoutAgent());
        if (hideToastIds.delete(toastId)) toast.dismiss(toastId);
        const { t, errorMessage } = currentText();
        actionToast.error(t(hidden ? "agent.error.hideFailed" : "agent.error.restoreFailed"), {
          description: errorMessage(error, t("agent.error.hiddenFailed")),
          report: { operation: "agent", source: "action", cause_code: classifyFailure(error) },
        });
      }
    }

    async function setAgentMuted(agentId: string, muted: boolean): Promise<void> {
      const previous = ownAgentLevels().get(agentId) ?? null;
      const level = muted ? "nothing" : null;
      if (previous === level) return;
      const serverId = activeServerId();
      const withLevel = (next: typeof previous) => ({
        agents: [
          ...[...ownAgentLevels()].flatMap(([id, own]) => (id === agentId ? [] : [{ agentId: id, level: own }])),
          ...(next ? [{ agentId, level: next }] : []),
        ],
      });
      applyOwnAgentLevels(withLevel(level));
      try {
        applyOwnAgentLevels(await agentsPort().agent.setAgentNotificationLevel({ agentId, level }, serverId));
      } catch (error) {
        if (!scopeIsCurrent()) return;
        applyOwnAgentLevels(withLevel(previous));
        const { t, errorMessage } = currentText();
        actionToast.error(t("agent.error.muteFailed"), {
          description: errorMessage(error, t("agent.error.hiddenFailed")),
          report: { operation: "agent", source: "action", cause_code: classifyFailure(error) },
        });
      }
    }

    return {
      createAgent,
      createChat,
      startChat,
      chatFolder,
      chooseChatFolder,
      clearChatFolder: () => rememberChatFolder(undefined),
      startChatInFolder,
      startSubagent,
      compactChat,
      importSessions,
      editAgent,
      duplicateAgent,
      duplicateSection,
      duplicatingSectionIds,
      deleteAgent,
      setAgentHiddenByUser,
      setAgentMuted,
    };
  },
});

export const AgentActionsProvider = AgentActions.provider;
export const useAgentActions = AgentActions.use;

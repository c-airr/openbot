import {
  type AccountUsage,
  type AccountUsageLimit,
  type AccountUsageWindow,
  type AgentProviderId,
  agentProviderDescriptor,
  agentProviderName,
  DEFAULT_PROVIDER_ACCOUNT_ID,
  isAgentProvider,
  type ProviderAccountStatus,
} from "@openbot/contracts/ipc";
import {
  type PlanLimitTone,
  planLimitWindowKind,
  reportedUsageWindows,
  usageRemainingPercent,
  usageTone,
} from "@openbot/team-client/plan-limits";
import { isApiKeyAccount, providerAccountName } from "../../components/provider-accounts";
import { currentText, type TextValue } from "../../text";

type UsageText = Pick<TextValue, "t" | "format">;

export type AccountUsageTone = PlanLimitTone;

export interface AccountUsageWindowRow {
  label: string;
  group?: { name: string; window: string };
  remainingPercent: number;
  /** What the UI shows: the share already used. */
  usedPercent: number;
  tone: AccountUsageTone;
  durationMins: number | null;
  resetsAt: number | null;
  resetsAtLabel: string | null;
}

export interface AccountUsageProviderRow {
  provider: AgentProviderId;
  accountId: string | null;
  name: string;
  remainingPercent: number | null;
  tone: AccountUsageTone;
  windows: AccountUsageWindowRow[];
  /**
   * The windows that the rail ring draws, outermost first: the reading's own, or for a provider that
   * names quota groups the 5-hour window of each group in the provider's order, so the ring shows
   * near limits only. Every weekly window stays in the hover card.
   */
  ringWindows: AccountUsageWindowRow[];
  reportsUsage: boolean;
  sharedQuotaWith: AgentProviderId | null;
  readFailed: boolean;
}

export function accountUsageProviderRows(
  usage: AccountUsage | null,
  providers?: ReadonlyArray<{ id: string; state: string; accounts?: readonly ProviderAccountStatus[] | undefined }>,
  text: UsageText = currentText(),
): AccountUsageProviderRow[] {
  const accountsOf = (provider: AgentProviderId) => {
    const accounts = providers?.find((candidate) => candidate.id === provider)?.accounts ?? [];
    return accounts.length > 1 ? accounts : [];
  };
  const rows = new Map<string, AccountUsageProviderRow>();
  for (const limit of usage?.limits ?? []) {
    if (!isAgentProvider(limit.id)) continue;
    const accountId = limit.accountId ?? null;
    rows.set(usageRowKey(limit.id, accountId), usageRow(limit.id, accountId, accountsOf(limit.id), limit, text));
  }
  for (const provider of providers ?? []) {
    if (!isAgentProvider(provider.id) || provider.state !== "available" || provider.id === "opencode") continue;
    const accounts = accountsOf(provider.id);
    const ids = accounts.length
      ? accounts.flatMap((account) =>
          account.id === DEFAULT_PROVIDER_ACCOUNT_ID
            ? [null]
            : account.state === "connected" && !isApiKeyAccount(account.id, provider.id)
              ? [account.id]
              : [],
        )
      : [null];
    for (const accountId of ids) {
      if (!rows.has(usageRowKey(provider.id, accountId)))
        rows.set(usageRowKey(provider.id, accountId), usageRow(provider.id, accountId, accounts, null, text));
    }
  }
  const accountOrder = (row: AccountUsageProviderRow) =>
    accountsOf(row.provider).findIndex((account) => account.id === (row.accountId ?? DEFAULT_PROVIDER_ACCOUNT_ID));
  return [...rows.values()].sort(
    (left, right) =>
      agentProviderDescriptor(left.provider).pickerOrder - agentProviderDescriptor(right.provider).pickerOrder ||
      accountOrder(left) - accountOrder(right),
  );
}

function usageRowKey(provider: AgentProviderId, accountId: string | null): string {
  return `${provider}\u0000${accountId ?? ""}`;
}

export function accountUsageRowKey(row: AccountUsageProviderRow): string {
  return usageRowKey(row.provider, row.accountId);
}

function usageRow(
  provider: AgentProviderId,
  accountId: string | null,
  accounts: readonly ProviderAccountStatus[],
  limit: AccountUsageLimit | null,
  text: UsageText,
): AccountUsageProviderRow {
  const windowRow = (window: AccountUsageWindow, label: string): AccountUsageWindowRow => {
    const remainingPercent = usageRemainingPercent(window.usedPercent);
    return {
      label,
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      tone: usageTone(remainingPercent),
      durationMins: window.windowDurationMins,
      resetsAt: window.resetsAt,
      resetsAtLabel: formatUsageReset(window.resetsAt, text),
    };
  };
  // Fork: Cursor keeps its two plan windows on the rail and the card. The split-plan total
  // (tertiary) stays out, so the two windows keep their rings and bars.
  const reported = limit
    ? provider === "cursor"
      ? reportedUsageWindows({ primary: limit.primary, secondary: limit.secondary })
      : reportedUsageWindows(limit)
    : [];
  const ownWindows = reported.map((window) =>
    windowRow(
      window,
      // One window alone is the whole plan.
      provider === "cursor" && limit?.primary && limit?.secondary
        ? text.t(window === limit?.primary ? "account.usage.window.cursorModels" : "account.usage.window.otherModels")
        : limit?.freeRequests
          ? text.t("account.usage.window.freeRequests", {
              remaining: limit.freeRequests.limit - limit.freeRequests.used,
              limit: limit.freeRequests.limit,
            })
          : usageWindowLabel(window.windowDurationMins, text),
    ),
  );
  const groups = limit?.groups ?? [];
  const windows =
    groups.length > 0
      ? groups.flatMap((group) => {
          const groupWindows = reportedUsageWindows(group);
          return groupWindows.map((window) => {
            const windowName = usageWindowLabel(window.windowDurationMins, text);
            const label =
              groupWindows.length > 1
                ? text.t("account.usage.window.group", { group: group.name, window: windowName })
                : group.name;
            return { ...windowRow(window, label), group: { name: group.name, window: windowName } };
          });
        })
      : ownWindows;
  // The rail ring shows the near limit of every quota group, not one group's weekly window: the
  // 5-hour window of each group, such as Gemini and Claude/GPT for Antigravity. A group without a
  // 5-hour window shows its binding window, so the rail keeps one ring per group. The card below
  // keeps every window of every group.
  const groupFiveHourWindows =
    groups.length > 1
      ? groups.flatMap((group) => {
          const groupReported = reportedUsageWindows(group);
          if (groupReported.length === 0) return [];
          const fiveHour = groupReported.find(
            (window) => planLimitWindowKind(window.windowDurationMins).kind === "fiveHour",
          );
          const picked =
            fiveHour ??
            groupReported.reduce((lowest, window) =>
              usageRemainingPercent(window.usedPercent) < usageRemainingPercent(lowest.usedPercent) ? window : lowest,
            );
          return [
            windowRow(
              picked,
              text.t("account.usage.window.group", {
                group: group.name,
                window: usageWindowLabel(picked.windowDurationMins, text),
              }),
            ),
          ];
        })
      : [];
  // OpenCode's third window is a list line only: `secondary` already holds the long window that stops
  // work first, and the ring has two tracks.
  // The ring windows come outermost first. A provider with several quota groups draws each group's
  // 5-hour window, in the provider's order: Antigravity's own Gemini window outside, the Claude and
  // GPT window inside, so the two 5-hour limits are the rings and every weekly window stays in the
  // hover card. One group keeps the longest window outside, as before.
  const ringWindows =
    groupFiveHourWindows.length > 1
      ? groupFiveHourWindows
      : ownWindows.filter((_, index) => reported[index] !== limit?.tertiary).reverse();
  // The window that stops work first, and on a tie the group that comes first, so its ring and chip
  // carry the lowest limit.
  const binding = ringWindows.reduce<AccountUsageWindowRow | null>(
    (lowest, window) => (lowest === null || window.remainingPercent < lowest.remainingPercent ? window : lowest),
    null,
  );
  const remainingPercent = binding?.remainingPercent ?? null;
  return {
    provider,
    accountId,
    name: accounts.length
      ? `${agentProviderName(provider)} · ${providerAccountName(text.t, accounts, accountId ?? DEFAULT_PROVIDER_ACCOUNT_ID)}`
      : agentProviderName(provider),
    remainingPercent,
    tone: usageTone(remainingPercent),
    windows,
    ringWindows,
    // Fork: OpenRouter reports only its free-model allowance, read apart from Pi.
    reportsUsage: agentProviderDescriptor(provider).reportsUsage || limit !== null,
    sharedQuotaWith: limit?.sharedQuotaWith ?? null,
    readFailed: limit?.readFailed === true && windows.length === 0,
  };
}

export function usageWindowLabel(durationMins: number | null, text: UsageText = currentText()): string {
  const { t } = text;
  const window = planLimitWindowKind(durationMins);
  switch (window.kind) {
    case "limit":
      return t("account.usage.window.limit");
    case "weekly":
      return t("account.usage.window.weekly");
    case "monthly":
      return t("account.usage.window.monthly");
    case "daily":
      return t("account.usage.window.daily");
    case "fiveHour":
      return t("account.usage.window.fiveHour");
    case "hours":
      return t("account.usage.window.hours", { count: window.hours });
    case "minutes":
      return t("account.usage.window.minutes", { minutes: window.minutes });
  }
}

export function formatUsageReset(resetsAt: number | null, text: UsageText = currentText()): string | null {
  if (resetsAt === null) return null;
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return null;
  return text.format.date(date, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatUsageResetIn(
  resetsAt: number | null,
  nowMs: number,
  text: UsageText = currentText(),
): string | null {
  if (resetsAt === null) return null;
  const remainingMs = resetsAt * 1_000 - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return text.t("account.usage.resetIn.days", { days, hours });
  if (hours > 0) return text.t("account.usage.resetIn.hours", { hours, minutes });
  return text.t("account.usage.resetIn.minutes", { minutes });
}

export function accountUsageRowLabel(
  row: AccountUsageProviderRow,
  text: UsageText = currentText(),
  loading = false,
): string {
  const { t } = text;
  if (!row.reportsUsage) return t("account.usage.row.notReported", { name: row.name });
  if (row.remainingPercent === null)
    return t(loading ? "account.usage.row.loading" : "account.usage.row.unavailable", { name: row.name });
  const parts = [row.name];
  for (const window of row.windows) {
    parts.push(t("account.usage.row.windowUsed", { window: window.label, percent: window.usedPercent }));
    if (window.resetsAtLabel) parts.push(t("account.usage.row.resets", { time: window.resetsAtLabel }));
  }
  return parts.join(", ");
}

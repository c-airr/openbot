import {
  type AccountUsage,
  type AgentReasoningEffort,
  type ClientAgentModelOption,
  isAgentProvider,
} from "@openbot/contracts/ipc";
import { accountUsageProviderRows } from "@openbot/ui/features/account/account-usage-view";

export interface CompactModelPick {
  model: ClientAgentModelOption;
  reasoningEffort?: AgentReasoningEffort | undefined;
}

/**
 * Fork: the preferred /compact chain. Gemini 3.8 Flash on medium first, then MiMo V2.6 Flash,
 * then Nemotron, then GPT-6 Luna on low, then the cheapest small model that still has room.
 */
const COMPACT_PREFERENCE: readonly { pattern: RegExp; effort?: AgentReasoningEffort }[] = [
  { pattern: /gemini.*3\.8.*flash/iu, effort: "medium" },
  { pattern: /mimo.*2\.6/iu },
  { pattern: /nemotron/iu },
  { pattern: /gpt-?6.*luna/iu, effort: "low" },
];

/** Fork: lower is cheaper. Models that match nothing are not used for a compaction. */
const CHEAP_RANK: readonly RegExp[] = [
  /flash.*low|low.*flash|flash-?lite/iu,
  /deepseek/iu,
  /flash|mini|haiku|nano|lite/iu,
];

/**
 * The cheapest model of a provider that still has room: the preferred chain first
 * (Gemini 3.8 Flash medium, MiMo V2.6, Nemotron, GPT-6 Luna low), then a Flash-low model,
 * then DeepSeek, then another small model. A provider whose reading shows nothing left is
 * skipped. `null` when no listed model matches, and the chat then keeps its own model.
 */
export function cheapestCompactModel(
  models: readonly ClientAgentModelOption[],
  usage: AccountUsage | null,
): CompactModelPick | null {
  const exhausted = new Set(
    accountUsageProviderRows(usage)
      .filter((row) => row.remainingPercent !== null && row.remainingPercent <= 0)
      .map((row) => row.provider),
  );
  const usable = models.filter(
    (model) => isAgentProvider(model.provider) && model.provider !== "openrouter" && !exhausted.has(model.provider),
  );
  // OpenRouter bills an API key whose balance OpenBot cannot read, so a Flash model there can fail at once.
  for (const { pattern, effort } of COMPACT_PREFERENCE) {
    const match = usable.find((model) => pattern.test(`${model.id} ${model.name}`));
    if (!match) continue;
    const reasoningEffort = effort && match.supportedReasoningEfforts.includes(effort) ? effort : undefined;
    return reasoningEffort ? { model: match, reasoningEffort } : { model: match };
  }
  let best: { model: ClientAgentModelOption; rank: number } | null = null;
  for (const model of usable) {
    const rank = CHEAP_RANK.findIndex((pattern) => pattern.test(`${model.id} ${model.name}`));
    if (rank < 0 || (best && best.rank <= rank)) continue;
    best = { model, rank };
  }
  return best ? { model: best.model } : null;
}

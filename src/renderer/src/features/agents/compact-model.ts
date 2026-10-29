import { type AccountUsage, type ClientAgentModelOption, isAgentProvider } from "@openbot/contracts/ipc";
import { accountUsageProviderRows } from "@openbot/ui/features/account/account-usage-view";

/** Fork: lower is cheaper. Models that match nothing are not used for a compaction. */
const CHEAP_RANK: readonly RegExp[] = [
  /flash.*low|low.*flash|flash-?lite/iu,
  /deepseek/iu,
  /flash|mini|haiku|nano|lite/iu,
];

/**
 * The cheapest model of a provider that still has room: a Flash-low model first, then DeepSeek,
 * then another small model. A provider whose reading shows nothing left is skipped. `null` when no
 * listed model matches, and the chat then keeps its own model.
 */
export function cheapestCompactModel(
  models: readonly ClientAgentModelOption[],
  usage: AccountUsage | null,
): ClientAgentModelOption | null {
  const exhausted = new Set(
    accountUsageProviderRows(usage)
      .filter((row) => row.remainingPercent !== null && row.remainingPercent <= 0)
      .map((row) => row.provider),
  );
  let best: { model: ClientAgentModelOption; rank: number } | null = null;
  for (const model of models) {
    // OpenRouter bills an API key whose balance OpenBot cannot read, so a Flash model there can fail at once.
    if (!isAgentProvider(model.provider) || model.provider === "openrouter" || exhausted.has(model.provider)) continue;
    const rank = CHEAP_RANK.findIndex((pattern) => pattern.test(`${model.id} ${model.name}`));
    if (rank < 0 || (best && best.rank <= rank)) continue;
    best = { model, rank };
  }
  return best?.model ?? null;
}

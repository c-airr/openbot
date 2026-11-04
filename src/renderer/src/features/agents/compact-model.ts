import {
  type AccountUsage,
  type AgentProviderId,
  type AgentReasoningEffort,
  type ClientAgentModelOption,
  isAgentProvider,
} from "@openbot/contracts/ipc";
import { accountUsageProviderRows } from "@openbot/ui/features/account/account-usage-view";

export type CompactAgentModel = ClientAgentModelOption & { provider: AgentProviderId };

export interface CompactModelPick {
  model: CompactAgentModel;
  reasoningEffort?: AgentReasoningEffort | undefined;
}

/**
 * Checks whether a model belongs to OpenAI / Codex / GPT.
 * We strictly exclude these to preserve the user's free / quota-limited GPT tier.
 */
export function isGptModel(model: ClientAgentModelOption): boolean {
  if (model.provider === "codex" || model.provider === "openai") return true;
  const text = `${model.id} ${model.name}`.toLowerCase();
  return /\b(gpt|chatgpt|openai)\b/iu.test(text) || /\bo[134](-|\b)/iu.test(text) || /gpt-?[0-9]/iu.test(text);
}

/**
 * Fork: the preferred /compact chain. Gemini models first (Gemini 3.8 Flash on medium,
 * Gemini 2.5 Flash, etc.), then OpenRouter models (Nemotron, free-tier models, MiMo).
 * Strictly excludes any GPT/Codex models to protect the user's free GPT quota.
 */
const COMPACT_PREFERENCE: readonly { pattern: RegExp; effort?: AgentReasoningEffort }[] = [
  // 1. Gemini / Google (Antigravity, FreeLLMAPI, or OpenRouter)
  { pattern: /gemini.*3\.8.*flash/iu, effort: "medium" },
  { pattern: /gemini.*2\.5.*flash/iu },
  { pattern: /gemini.*flash/iu },
  { pattern: /auto:gemini/iu },
  { pattern: /gemini/iu },
  // 2. OpenRouter & High-Value Free models
  { pattern: /nemotron.*3\.5.*super.*vl/iu },
  { pattern: /nemotron/iu },
  { pattern: /mimo.*2\.6/iu },
  { pattern: /:free$/iu },
];

/** Fork: lower is cheaper. Strictly non-GPT models only. */
const CHEAP_RANK: readonly RegExp[] = [
  /flash.*low|low.*flash|flash-?lite/iu,
  /deepseek/iu,
  /flash|haiku|nano|lite/iu,
  /openrouter/iu,
];

/**
 * The cheapest model of a provider that still has room: prefers Gemini, then OpenRouter
 * (Nemotron, free models, MiMo), then small Flash/Lite/Haiku/DeepSeek models.
 * Strictly avoids any GPT / Codex / OpenAI models so the user's free tier quota is never spent on compaction.
 * Returns `null` if no non-GPT model matches or has quota.
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
  // Strictly filter out all GPT/Codex models and exhausted providers. Allow OpenRouter.
  const usable = models.filter(
    (model): model is CompactAgentModel =>
      isAgentProvider(model.provider) && !isGptModel(model) && !exhausted.has(model.provider),
  );

  // 1. Preferred chain (Gemini -> Nemotron -> MiMo -> OpenRouter :free)
  for (const { pattern, effort } of COMPACT_PREFERENCE) {
    const match = usable.find((model) => pattern.test(`${model.id} ${model.name}`));
    if (!match) continue;
    const reasoningEffort = effort && match.supportedReasoningEfforts.includes(effort) ? effort : undefined;
    return reasoningEffort ? { model: match, reasoningEffort } : { model: match };
  }

  // 2. Ranked fallback among remaining usable models
  let best: { model: CompactAgentModel; rank: number } | null = null;
  for (const model of usable) {
    const rank = CHEAP_RANK.findIndex((pattern) => pattern.test(`${model.id} ${model.name}`));
    if (rank < 0 || (best && best.rank <= rank)) continue;
    best = { model, rank };
  }
  if (best) return { model: best.model };

  // 3. Any Gemini or OpenRouter model that is usable
  const geminiOrOpenRouter = usable.find(
    (model) =>
      /gemini/iu.test(`${model.id} ${model.name}`) ||
      model.provider === "openrouter" ||
      model.provider === "antigravity",
  );
  if (geminiOrOpenRouter) return { model: geminiOrOpenRouter };

  // 4. Any other non-GPT usable model
  const anyNonGpt = usable[0];
  return anyNonGpt ? { model: anyNonGpt } : null;
}

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
 * Gemini 2.5 Flash, etc.), then OpenCode and smaller models from other providers.
 */
const COMPACT_PREFERENCE: readonly { pattern: RegExp; effort?: AgentReasoningEffort }[] = [
  { pattern: /gemini.*3\.8.*flash/iu, effort: "medium" },
  { pattern: /gemini.*2\.5.*flash/iu },
  { pattern: /gemini.*flash/iu },
  { pattern: /auto:gemini/iu },
  { pattern: /gemini/iu },
];

/** Fork: lower is cheaper. Strictly non-GPT models only. */
const CHEAP_RANK: readonly RegExp[] = [/flash.*low|low.*flash|flash-?lite/iu, /deepseek/iu, /flash|haiku|nano|lite/iu];

/**
 * Pick a model with room. Compaction reads the full chat history, so exclude OpenRouter and
 * routed OpenRouter models. Exclude GPT / Codex / OpenAI to preserve the user's quota.
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
    (model): model is CompactAgentModel =>
      isAgentProvider(model.provider) &&
      !isGptModel(model) &&
      !exhausted.has(model.provider) &&
      model.provider !== "openrouter" &&
      !/(?:^|\/)openrouter(?:\/|$)|:free$/iu.test(model.id),
  );

  const openCode = usable.filter((model) => model.provider === "opencode");
  const openCodeFree = openCode.find((model) => /^opencode\/(?:big-pickle|[^/]+-free)$/iu.test(model.id));
  const openCodeBackup = openCodeFree ?? openCode.find((model) => model.id.startsWith("opencode-go/"));
  if (exhausted.has("antigravity") && openCodeBackup) return { model: openCodeBackup };

  for (const { pattern, effort } of COMPACT_PREFERENCE) {
    const match = usable.find((model) => pattern.test(`${model.id} ${model.name}`));
    if (!match) continue;
    const reasoningEffort = effort && match.supportedReasoningEfforts.includes(effort) ? effort : undefined;
    return reasoningEffort ? { model: match, reasoningEffort } : { model: match };
  }
  if (openCodeBackup) return { model: openCodeBackup };

  // 2. Ranked fallback among remaining usable models
  let best: { model: CompactAgentModel; rank: number } | null = null;
  for (const model of usable) {
    const rank = CHEAP_RANK.findIndex((pattern) => pattern.test(`${model.id} ${model.name}`));
    if (rank < 0 || (best && best.rank <= rank)) continue;
    best = { model, rank };
  }
  if (best) return { model: best.model };

  // Other non-GPT models come last.
  const anyNonGpt = usable[0];
  return anyNonGpt ? { model: anyNonGpt } : null;
}

import { isDynamicRecord } from "./runtime-values";

/**
 * Fork: what FreeLLMAPI (`GET /v1/budzet`) has left today, from midnight UTC. Only on a computer with
 * `openbot-freellmapi-v1.json` in the app data folder; elsewhere the request answers null.
 */
export interface FreeLlmBudgetProvider {
  platform: string;
  tokensPerDay: number | null;
  tokensToday: number;
  tokensLeft: number | null;
}

export interface FreeLlmBudgetModel extends FreeLlmBudgetProvider {
  name: string;
  modelId: string;
  rank: number | null;
  requestsPerDay: number | null;
  requestsToday: number;
  requestsLeft: number | null;
  /** Where the daily limit comes from: the provider's documentation, a 429 seen, or an estimate. */
  source: "official" | "learned" | "estimate";
}

export interface FreeLlmBudget {
  /** The chain whose models these are (`auto:<chain>`), or null for the active chain. */
  chain: string | null;
  /** Unix seconds of the next midnight UTC. */
  resetsAt: number;
  providers: FreeLlmBudgetProvider[];
  models: FreeLlmBudgetModel[];
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCountOrNull(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isProvider(value: unknown): value is FreeLlmBudgetProvider {
  return (
    isDynamicRecord(value) &&
    typeof value.platform === "string" &&
    isCountOrNull(value.tokensPerDay) &&
    isCount(value.tokensToday) &&
    isCountOrNull(value.tokensLeft)
  );
}

function isModel(value: unknown): value is FreeLlmBudgetModel {
  return (
    isProvider(value) &&
    isDynamicRecord(value) &&
    typeof value.name === "string" &&
    typeof value.modelId === "string" &&
    isCountOrNull(value.rank) &&
    isCountOrNull(value.requestsPerDay) &&
    isCount(value.requestsToday) &&
    isCountOrNull(value.requestsLeft) &&
    (value.source === "official" || value.source === "learned" || value.source === "estimate")
  );
}

export function decodeFreeLlmBudget(value: unknown): FreeLlmBudget | null {
  if (value === null) return null;
  if (
    !isDynamicRecord(value) ||
    (value.chain !== null && typeof value.chain !== "string") ||
    !isCount(value.resetsAt) ||
    !Array.isArray(value.providers) ||
    !value.providers.every(isProvider) ||
    !Array.isArray(value.models) ||
    !value.models.every(isModel)
  )
    throw new Error("Invalid FreeLLMAPI budget.");
  return { chain: value.chain, resetsAt: value.resetsAt, providers: value.providers, models: value.models };
}

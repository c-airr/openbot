// Fork: the daily free-model allowance and the credit balance of an OpenRouter key, from
// `GET /api/v1/key` and `GET /api/v1/credits`.
//
// OpenRouter counts the requests to `:free` models per account and UTC day: 50 a day, or 1000 after
// 10 USD of credits bought. The count is OpenRouter's own, so requests made outside OpenBot count too.
// The balance is what those credits have left, read with the NBP rate of the day for PLN.

import type { AccountUsage, OpenRouterBalance } from "@openbot/contracts/ipc";
import { Effect, Option, Schema } from "effect";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const NBP_USD_URL = "https://api.nbp.pl/api/exchangerates/rates/A/usd/?format=json";
const OPENROUTER_KEY_TIMEOUT_MS = 10_000;
const NBP_TIMEOUT_MS = 4_000;
const DAY_MINS = 1_440;

const KeyInfo = Schema.Struct({
  data: Schema.Struct({
    free_model_daily_requests: Schema.Struct({ used: Schema.Finite, limit: Schema.Finite }),
  }),
});

const Credits = Schema.Struct({
  data: Schema.Struct({ total_credits: Schema.Finite, total_usage: Schema.Finite }),
});

const NbpRate = Schema.Struct({ rates: Schema.Array(Schema.Struct({ mid: Schema.Finite })) });

class OpenRouterUsageFailed extends Schema.TaggedError<OpenRouterUsageFailed>()("OpenRouterUsageFailed", {
  cause: Schema.Defect(),
}) {}

/** The NBP mid rate of the day, or null: a balance without a rate still shows in USD. */
async function readPlnPerUsd(): Promise<number | null> {
  const response = await fetch(NBP_USD_URL, { signal: AbortSignal.timeout(NBP_TIMEOUT_MS) }).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  const decoded = Option.getOrNull(Schema.decodeUnknownOption(NbpRate)(body));
  return decoded?.rates[0]?.mid ?? null;
}

/** The balance, or null: a key without a credits route keeps its free-model reading. */
async function readBalance(apiKey: string): Promise<OpenRouterBalance | null> {
  const response = await fetch(OPENROUTER_CREDITS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(OPENROUTER_KEY_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  const decoded = Option.getOrNull(Schema.decodeUnknownOption(Credits)(body));
  if (!decoded) return null;
  const { total_credits, total_usage } = decoded.data;
  return {
    totalUsd: total_credits,
    usedUsd: total_usage,
    remainingUsd: total_credits - total_usage,
    plnPerUsd: await readPlnPerUsd(),
    readAt: Math.floor(Date.now() / 1_000),
  };
}

/** The free-model reading of the key, or no limits when there is no key or OpenRouter rejects it. */
export const readOpenRouterUsage = Effect.fn("OpenRouter.readUsage")(function* (apiKey: string | null) {
  if (!apiKey) return { limits: [] } satisfies AccountUsage;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(OPENROUTER_KEY_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(OPENROUTER_KEY_TIMEOUT_MS)]),
      }),
    catch: (cause) => new OpenRouterUsageFailed({ cause }),
  });
  const balance = yield* Effect.promise(() => readBalance(apiKey));
  if (response.status === 401 || response.status === 403)
    return balance
      ? ({ limits: [balanceLimit(balance)] } satisfies AccountUsage)
      : ({ limits: [] } satisfies AccountUsage);
  if (!response.ok)
    return yield* new OpenRouterUsageFailed({ cause: new Error(`OpenRouter key returned HTTP ${response.status}.`) });
  const body = yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: (cause) => new OpenRouterUsageFailed({ cause }),
  });
  const { used, limit } = (yield* Schema.decodeUnknownEffect(KeyInfo)(body).pipe(
    Effect.mapError((cause) => new OpenRouterUsageFailed({ cause })),
  )).data.free_model_daily_requests;
  if (limit <= 0)
    return balance
      ? ({ limits: [balanceLimit(balance)] } satisfies AccountUsage)
      : ({ limits: [] } satisfies AccountUsage);
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return {
    limits: [
      {
        id: "openrouter",
        primary: {
          usedPercent: Math.min(100, (used / limit) * 100),
          windowDurationMins: DAY_MINS,
          resetsAt: midnight.getTime() / 1_000,
        },
        secondary: null,
        freeRequests: { used: Math.min(used, limit), limit },
        ...(balance ? { balance } : {}),
      },
    ],
  } satisfies AccountUsage;
});

/** The balance alone, for a key whose free-model allowance is spent or unreported. */
function balanceLimit(balance: OpenRouterBalance) {
  return { id: "openrouter", primary: null, secondary: null, balance } satisfies AccountUsage["limits"][number];
}

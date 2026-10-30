// Fork: the daily free-model allowance of an OpenRouter key, from `GET /api/v1/key`.
//
// OpenRouter counts the requests to `:free` models per account and UTC day: 50 a day, or 1000 after
// 10 USD of credits bought. The count is OpenRouter's own, so requests made outside OpenBot count too.

import type { AccountUsage } from "@openbot/contracts/ipc";
import { Effect, Schema } from "effect";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_KEY_TIMEOUT_MS = 10_000;
const DAY_MINS = 1_440;

const KeyInfo = Schema.Struct({
  data: Schema.Struct({
    free_model_daily_requests: Schema.Struct({ used: Schema.Finite, limit: Schema.Finite }),
  }),
});

class OpenRouterUsageFailed extends Schema.TaggedError<OpenRouterUsageFailed>()("OpenRouterUsageFailed", {
  cause: Schema.Defect(),
}) {}

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
  if (response.status === 401 || response.status === 403) return { limits: [] } satisfies AccountUsage;
  if (!response.ok)
    return yield* new OpenRouterUsageFailed({ cause: new Error(`OpenRouter key returned HTTP ${response.status}.`) });
  const body = yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: (cause) => new OpenRouterUsageFailed({ cause }),
  });
  const { used, limit } = (yield* Schema.decodeUnknownEffect(KeyInfo)(body).pipe(
    Effect.mapError((cause) => new OpenRouterUsageFailed({ cause })),
  )).data.free_model_daily_requests;
  if (limit <= 0) return { limits: [] } satisfies AccountUsage;
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
      },
    ],
  } satisfies AccountUsage;
});

// Fork: which upstream provider serves an OpenRouter model, and the prices of each one.
//
// `GET /api/v1/models/<model>/endpoints` lists the providers of a model with their prices per
// token. The choice is kept in Pi's own `models.json`, because OpenBot's OpenRouter requests run
// through the Pi CLI: it sends `compat.openRouterRouting` as the request's `provider` field, so
// pinning a provider there is what stops OpenRouter from moving the model to another endpoint.
// A model without a pin keeps OpenRouter's own routing.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type OpenRouterRouteOption, type OpenRouterRoutes, openRouterModelId } from "@openbot/contracts/ipc";
import { Effect, Option, Schema } from "effect";
import { piAgentDirectory } from "./process-confinement";

const OPENROUTER_ENDPOINTS_BASE = "https://openrouter.ai/api/v1/models";
const OPENROUTER_TIMEOUT_MS = 15_000;
const MODELS_FILE = "models.json";

/** The parts of a JSON document this module reads and writes; every other key stays as it is. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const LivePricing = Schema.Struct({
  prompt: Schema.optional(Schema.Unknown),
  completion: Schema.optional(Schema.Unknown),
});

const LiveEndpoint = Schema.Struct({
  provider_name: Schema.optional(Schema.Unknown),
  tag: Schema.optional(Schema.Unknown),
  context_length: Schema.optional(Schema.Unknown),
  pricing: Schema.optional(LivePricing),
});

const LiveEndpoints = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      endpoints: Schema.optional(Schema.Array(LiveEndpoint)),
    }),
  ),
});

function modelsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(piAgentDirectory(env), MODELS_FILE);
}

function tokenPricePerMillion(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? roundPrice(value * 1_000_000) : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundPrice(parsed * 1_000_000) : null;
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function contextLength(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** The routes of one model, with their prices; an empty list when OpenRouter cannot be read. */
async function readLiveRoutes(model: string): Promise<OpenRouterRouteOption[]> {
  const response = await fetch(`${OPENROUTER_ENDPOINTS_BASE}/${model}/endpoints`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return [];
  const body = await response.json().catch(() => null);
  const decoded = Option.getOrNull(Schema.decodeUnknownOption(LiveEndpoints)(body));
  const endpoints = decoded?.data?.endpoints ?? [];
  const routes: OpenRouterRouteOption[] = [];
  for (const endpoint of endpoints) {
    const provider = typeof endpoint.tag === "string" ? endpoint.tag.trim() : "";
    if (!provider) continue;
    const name = typeof endpoint.provider_name === "string" ? endpoint.provider_name.trim() : provider;
    routes.push({
      provider,
      name: name || provider,
      promptPerMillion: tokenPricePerMillion(endpoint.pricing?.prompt),
      completionPerMillion: tokenPricePerMillion(endpoint.pricing?.completion),
      contextLength: contextLength(endpoint.context_length),
    });
  }
  return routes.sort((left, right) => {
    const leftPrice = left.promptPerMillion ?? Number.POSITIVE_INFINITY;
    const rightPrice = right.promptPerMillion ?? Number.POSITIVE_INFINITY;
    return leftPrice === rightPrice ? left.name.localeCompare(right.name) : leftPrice - rightPrice;
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: JsonValue | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

async function readModelsFile(path: string): Promise<JsonObject> {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if (isObject(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never overwrite a file OpenBot cannot read: the user may keep their own models there.
    throw new Error("Pi's models.json is not valid JSON, so the OpenRouter provider cannot be saved.");
  }
  return isObject(parsed) ? parsed : {};
}

/** The routing object pinned for a model, if any. */
function routingIn(models: JsonObject, model: string): JsonObject | undefined {
  const override = objectAt(objectAt(objectAt(objectAt(models.providers)?.openrouter)?.modelOverrides)?.[model]);
  return objectAt(objectAt(override?.compat)?.openRouterRouting);
}

/** The provider pinned in a routing object, if any. */
function pinnedProvider(routing: JsonObject | undefined): string | null {
  if (!routing) return null;
  for (const key of ["only", "order"] as const) {
    const list = routing[key];
    if (!Array.isArray(list)) continue;
    const first = list.find((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    if (first) return first.trim();
  }
  return null;
}

function pruneEmpty(record: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(record)) {
    const nested = objectAt(value);
    if (!nested) continue;
    const pruned = pruneEmpty(nested);
    if (Object.keys(pruned).length === 0) delete record[key];
    else record[key] = pruned;
  }
  return record;
}

/** Puts the routing of one model into the file's object, keeping every other entry as it is. */
function withRouting(models: JsonObject, model: string, provider: string | null): JsonObject {
  const providers = objectAt(models.providers) ?? {};
  const openrouter = objectAt(providers.openrouter) ?? {};
  const overrides = objectAt(openrouter.modelOverrides) ?? {};
  const override = objectAt(overrides[model]) ?? {};
  const compat = objectAt(override.compat) ?? {};
  if (provider === null) delete compat.openRouterRouting;
  else compat.openRouterRouting = { only: [provider], allow_fallbacks: false };
  const nextCompat = pruneEmpty(compat);
  if (Object.keys(nextCompat).length > 0) override.compat = nextCompat;
  else delete override.compat;
  if (Object.keys(override).length > 0) overrides[model] = override;
  else delete overrides[model];
  if (Object.keys(overrides).length > 0) openrouter.modelOverrides = overrides;
  else delete openrouter.modelOverrides;
  if (Object.keys(openrouter).length > 0) providers.openrouter = openrouter;
  else delete providers.openrouter;
  if (Object.keys(providers).length > 0) models.providers = providers;
  else delete models.providers;
  return models;
}

async function writeModelsFile(path: string, models: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.openbot-tmp`;
  await writeFile(temporary, `${JSON.stringify(models, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** The model's providers with their prices, and the one the user pinned. */
export const readOpenRouterRoutes = Effect.fn("OpenRouterRoutes.read")(function* (model: string) {
  const valid = openRouterModelId(model);
  if (!valid) throw new Error("That is not an OpenRouter model id.");
  const models = yield* Effect.promise(() => readModelsFile(modelsPath()));
  const options = yield* Effect.promise(() => readLiveRoutes(valid));
  return { model: valid, current: pinnedProvider(routingIn(models, valid)), options } satisfies OpenRouterRoutes;
});

/** Pins a provider for one model, or clears the pin when `provider` is null. */
export const setOpenRouterRoute = Effect.fn("OpenRouterRoutes.set")(function* (input: {
  model: string;
  provider: string | null;
}) {
  const model = openRouterModelId(input.model);
  if (!model) throw new Error("That is not an OpenRouter model id.");
  yield* Effect.promise(async () => {
    const path = modelsPath();
    const models = await readModelsFile(path);
    await writeModelsFile(path, withRouting(models, model, input.provider));
  });
  return yield* readOpenRouterRoutes(model);
});

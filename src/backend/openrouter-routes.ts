// Fork: which upstream provider serves an OpenRouter model, and the prices of each one.
//
// `GET /api/v1/models/<model>/endpoints` lists the providers of a model with their prices per
// token. The model page also publishes each endpoint's training policy. Pi's `models.json` holds
// routing preferences, and the OpenRouter extension in Pi reads them before each request.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type OpenRouterRouteOption,
  type OpenRouterRouteSettings,
  type OpenRouterRoutes,
  openRouterModelId,
  openRouterProviderSlug,
  type SetOpenRouterRouteInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Option, Schema, Semaphore } from "effect";
import { piAgentDirectory } from "./process-confinement";

const OPENROUTER_ENDPOINTS_BASE = "https://openrouter.ai/api/v1/models";
const OPENROUTER_TIMEOUT_MS = 15_000;
const MODELS_FILE = "models.json";
const routeWrites = Semaphore.makeUnsafe(1);

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
  data_policy: Schema.optional(Schema.Unknown),
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
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return null;
  return numeric * 1_000_000;
}

function contextLength(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function trainingPolicy(policy: unknown): boolean | null {
  return isDynamicRecord(policy) && typeof policy.training === "boolean" ? policy.training : null;
}

function readEndpointTraining(flight: string, free: boolean): Map<string, boolean> {
  const training = new Map<string, boolean>();
  for (const line of flight.split("\n")) {
    const payload = /^[\da-f]+:([[{].*)$/u.exec(line)?.[1];
    if (!payload) continue;
    const records: unknown[] = [];
    try {
      records.push(JSON.parse(payload));
    } catch {
      continue;
    }
    while (records.length > 0) {
      const record = records.pop();
      if (Array.isArray(record)) {
        for (const child of record) if (child && typeof child === "object") records.push(child);
      } else if (isDynamicRecord(record)) {
        const slug = openRouterProviderSlug(record.provider_slug);
        const policy = trainingPolicy(record.data_policy);
        if (slug && record.is_free === free && policy !== null)
          training.set(slug, policy || training.get(slug) === true);
        for (const child of Object.values(record)) if (child && typeof child === "object") records.push(child);
      }
    }
  }
  return training;
}

async function readPublishedTraining(model: string, signal: AbortSignal): Promise<Map<string, boolean>> {
  const response = await fetch(`https://openrouter.ai/${model}`, {
    headers: { RSC: "1" },
    signal,
    redirect: "error",
  }).catch(() => null);
  if (!response?.ok || !response.headers.get("content-type")?.includes("text/x-component")) return new Map();
  const body = await response.text().catch(() => "");
  return readEndpointTraining(body, model.endsWith(":free"));
}

async function readLiveRoutes(model: string): Promise<OpenRouterRouteOption[]> {
  const catalogModel = model.replace(/:(?:batch|nitro|extended|thinking|online|floor)$/u, "");
  const signal = AbortSignal.timeout(OPENROUTER_TIMEOUT_MS);
  const [body, training] = await Promise.all([
    fetch(`${OPENROUTER_ENDPOINTS_BASE}/${catalogModel}/endpoints`, {
      headers: { Accept: "application/json" },
      signal,
      redirect: "error",
    }).then((response) => {
      if (!response.ok) throw new Error("Cannot read OpenRouter endpoints.");
      return response.json();
    }),
    readPublishedTraining(catalogModel, signal),
  ]);
  const decoded = Option.getOrNull(Schema.decodeUnknownOption(LiveEndpoints)(body));
  const endpoints = decoded?.data?.endpoints;
  if (!endpoints) throw new Error("Invalid OpenRouter endpoints response.");
  const routes = new Map<string, OpenRouterRouteOption>();
  for (const endpoint of endpoints) {
    const provider = openRouterProviderSlug(endpoint.tag);
    if (!provider || routes.has(provider)) continue;
    const name = typeof endpoint.provider_name === "string" ? endpoint.provider_name.trim() : provider;
    routes.set(provider, {
      provider,
      name: name || provider,
      promptPerMillion: tokenPricePerMillion(endpoint.pricing?.prompt),
      completionPerMillion: tokenPricePerMillion(endpoint.pricing?.completion),
      contextLength: contextLength(endpoint.context_length),
      trainsOnData: trainingPolicy(endpoint.data_policy) ?? training.get(provider) ?? null,
    });
  }
  return [...routes.values()];
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
  if (!isObject(parsed)) throw new Error("Pi's models.json must contain a JSON object.");
  return parsed;
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

/** Puts the routing of one model into the file's object, keeping every other entry as it is. */
function withRouting(models: JsonObject, { model, provider, noTraining }: SetOpenRouterRouteInput): JsonObject {
  const providers = objectAt(models.providers) ?? {};
  const openrouter = objectAt(providers.openrouter) ?? {};
  const overrides = objectAt(openrouter.modelOverrides) ?? {};
  const override = objectAt(overrides[model]) ?? {};
  const compat = objectAt(override.compat) ?? {};
  const routing = objectAt(compat.openRouterRouting) ?? {};
  if (provider !== pinnedProvider(routing)) {
    delete routing.order;
    if (provider === null) {
      delete routing.only;
      if (routing.allow_fallbacks === false) delete routing.allow_fallbacks;
    } else {
      routing.only = [provider];
      routing.allow_fallbacks = false;
    }
  }
  if (noTraining === true) routing.data_collection = "deny";
  if (noTraining === false && routing.data_collection === "deny") delete routing.data_collection;
  if (Object.keys(routing).length > 0) compat.openRouterRouting = routing;
  else delete compat.openRouterRouting;
  if (Object.keys(compat).length > 0) override.compat = compat;
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

function routeSettings(models: JsonObject, model: string): OpenRouterRouteSettings {
  const routing = routingIn(models, model);
  return { model, current: pinnedProvider(routing), noTraining: routing?.data_collection === "deny" };
}

/** The model's providers with their prices, and the one the user pinned. */
export const readOpenRouterRoutes = Effect.fn("OpenRouterRoutes.read")(function* (model: string) {
  const valid = openRouterModelId(model);
  if (!valid) throw new Error("That is not an OpenRouter model id.");
  const [models, options] = yield* Effect.tryPromise({
    try: () => Promise.all([readModelsFile(modelsPath()), readLiveRoutes(valid)]),
    catch: (cause) => ({ cause }),
  });
  return { ...routeSettings(models, valid), options } satisfies OpenRouterRoutes;
});

/** Pins a provider for one model, or clears the pin when `provider` is null. */
export const setOpenRouterRoute = Effect.fn("OpenRouterRoutes.set")(function* (input: SetOpenRouterRouteInput) {
  const model = openRouterModelId(input.model);
  if (!model) throw new Error("That is not an OpenRouter model id.");
  return yield* routeWrites.withPermit(
    Effect.tryPromise({
      try: async () => {
        const path = modelsPath();
        const models = withRouting(await readModelsFile(path), { ...input, model });
        await writeModelsFile(path, models);
        return routeSettings(models, model);
      },
      catch: (cause) => ({ cause }),
    }).pipe(Effect.uninterruptible),
  );
});

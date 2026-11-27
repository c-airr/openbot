// Fork: the OpenRouter endpoint that serves one model. OpenRouter answers with several providers
// for the same model, at different prices; the picker shows them and the choice is kept in Pi's
// own `models.json`.

/** One upstream provider of a model, as `GET /api/v1/models/<model>/endpoints` lists it. */
export interface OpenRouterRouteOption {
  /** The routing slug OpenRouter expects in `provider.only`, such as "anthropic". */
  provider: string;
  /** The display name OpenRouter gives the same provider. */
  name: string;
  /** USD per million prompt tokens, or null when OpenRouter reports no price. */
  promptPerMillion: number | null;
  /** USD per million completion tokens, or null when OpenRouter reports no price. */
  completionPerMillion: number | null;
  contextLength: number | null;
  trainsOnData: boolean | null;
}

export interface OpenRouterRouteSettings {
  model: string;
  /** The provider slug the user pinned, or null for OpenRouter's own routing. */
  current: string | null;
  noTraining: boolean;
}

export interface OpenRouterRoutes extends OpenRouterRouteSettings {
  options: OpenRouterRouteOption[];
}

export interface SetOpenRouterRouteInput {
  model: string;
  /** A provider slug, or null to let OpenRouter route the model again. */
  provider: string | null;
  noTraining?: boolean;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:~+@-]*$/u;
const PROVIDER_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:~+@/-]{0,79}$/u;

/** An OpenRouter model id such as "anthropic/claude-sonnet-4.5", or null when it is not one. */
export function openRouterModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length <= 200 && MODEL_ID.test(model) ? model : null;
}

/** A provider routing slug such as "anthropic" or "google-vertex/global", or null. */
export function openRouterProviderSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim();
  return PROVIDER_SLUG.test(slug) && !slug.includes("..") ? slug : null;
}

import type {
  OpenRouterRouteOption,
  OpenRouterRouteSettings,
  OpenRouterRoutes,
  SetOpenRouterRouteInput,
} from "@openbot/contracts/ipc";
import { Button, buttonVariants, Check, Checkbox, ChevronDown, Popover } from "@openbot/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { useText } from "../text";

type PriceSort = "total" | "prompt" | "completion";

const PRICE_SORTS = [
  { id: "total", label: "provider.picker.openrouterSortTotal" },
  { id: "prompt", label: "provider.picker.openrouterPriceInput" },
  { id: "completion", label: "provider.picker.openrouterPriceOutput" },
] as const;

function sortPrice(route: OpenRouterRouteOption, sort: PriceSort): number {
  const prompt = route.promptPerMillion ?? Number.POSITIVE_INFINITY;
  const completion = route.completionPerMillion ?? Number.POSITIVE_INFINITY;
  if (sort === "prompt") return prompt;
  if (sort === "completion") return completion;
  return prompt + completion;
}

export function OpenRouterRoutePicker(props: {
  model: string;
  disabled: boolean;
  routes: (model: string) => Promise<OpenRouterRoutes>;
  save: (input: SetOpenRouterRouteInput) => Promise<OpenRouterRouteSettings>;
}) {
  const { format, t } = useText();
  const filterId = createUniqueId();
  const model = () => props.model.replace(/^~/u, "");
  const [routes, setRoutes] = createSignal<OpenRouterRoutes>();
  const [open, setOpen] = createSignal(false);
  const [sort, setSort] = createSignal<PriceSort>("total");
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [saveFailed, setSaveFailed] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let readId = 0;

  async function load(id: string) {
    const request = ++readId;
    setRoutes(undefined);
    setLoadFailed(false);
    setSaveFailed(false);
    try {
      const result = await props.routes(id);
      if (request === readId) setRoutes(result);
    } catch {
      if (request === readId) setLoadFailed(true);
    }
  }

  createEffect(model, (id) => void load(id));

  const selected = createMemo(() => {
    const current = routes()?.current;
    return routes()?.options.find((route) => route.provider === current);
  });
  const options = createMemo(() => {
    const catalog = routes();
    if (!catalog) return [];
    const order = sort();
    return catalog.options
      .filter((route) => !catalog.noTraining || route.trainsOnData === false)
      .sort((left, right) => {
        const a = sortPrice(left, order);
        const b = sortPrice(right, order);
        return a === b ? left.name.localeCompare(right.name) || left.provider.localeCompare(right.provider) : a - b;
      });
  });
  const blocked = () => props.disabled || saving() || !routes();
  const price = (value: number | null) =>
    value === null ? "—" : format.currencyUsd(value, { minimumFractionDigits: 2, maximumFractionDigits: 6 });

  async function save(provider: string | null, noTraining: boolean) {
    const catalog = routes();
    if (!catalog || blocked() || (provider === catalog.current && noTraining === catalog.noTraining)) return;
    const request = readId;
    setSaving(true);
    setSaveFailed(false);
    try {
      const settings = await props.save({ model: catalog.model, provider, noTraining });
      if (request === readId) setRoutes({ ...catalog, ...settings });
    } catch {
      if (request === readId) setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="provider-model-effort">
      <span>{t("provider.picker.openrouterRoute")}</span>
      <Popover.Root open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={4}>
        <Popover.Trigger
          class={buttonVariants({ variant: "ghost", size: "sm", class: "openrouter-route-trigger" })}
          aria-label={t("provider.picker.openrouterRoute")}
          disabled={props.disabled}
        >
          <span>{selected()?.name ?? routes()?.current ?? t("provider.picker.openrouterRouteAuto")}</span>
          <ChevronDown />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            class="ui-popover-menu-surface openrouter-route-content"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setOpen(false);
            }}
          >
            <div class="openrouter-route-heading">
              <Popover.Title>{t("provider.picker.openrouterRoute")}</Popover.Title>
              <span>{t("provider.picker.openrouterPriceUnit")}</span>
            </div>
            <Show
              when={routes()}
              fallback={
                <div class="openrouter-route-message" role="status">
                  <Show when={loadFailed()} fallback={t("provider.picker.openrouterRouteLoading")}>
                    {t("provider.picker.openrouterRouteFailed")}
                    <Button variant="ghost" size="sm" onClick={() => void load(model())}>
                      {t("common.retry")}
                    </Button>
                  </Show>
                </div>
              }
            >
              {(catalog) => (
                <>
                  <div class="openrouter-route-toolbar">
                    <label class="openrouter-route-filter" for={filterId}>
                      <Checkbox
                        id={filterId}
                        checked={catalog().noTraining}
                        disabled={blocked()}
                        onChange={(event) => {
                          const noTraining = event.currentTarget.checked;
                          const provider = noTraining && selected()?.trainsOnData !== false ? null : catalog().current;
                          event.currentTarget.checked = catalog().noTraining;
                          void save(provider, noTraining);
                        }}
                      />
                      {t("provider.picker.openrouterNoTraining")}
                    </label>
                    <fieldset class="openrouter-route-sort" aria-label={t("provider.picker.openrouterSort")}>
                      <span aria-hidden="true">{t("provider.picker.openrouterSort")}</span>
                      <For each={PRICE_SORTS}>
                        {(option) => (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-pressed={sort() === option.id ? "true" : "false"}
                            onClick={() => setSort(option.id)}
                          >
                            {t(option.label)}
                          </Button>
                        )}
                      </For>
                    </fieldset>
                  </div>
                  <Button
                    variant="ghost"
                    class="openrouter-route-auto"
                    disabled={blocked()}
                    aria-pressed={catalog().current === null ? "true" : "false"}
                    onClick={() => void save(null, catalog().noTraining)}
                  >
                    <span>
                      <strong>{t("provider.picker.openrouterRouteAuto")}</strong>
                      <small>{t("provider.picker.openrouterRouteAutoDetail")}</small>
                    </span>
                    <Show when={catalog().current === null}>
                      <Check />
                    </Show>
                  </Button>
                  <div class="openrouter-route-list">
                    <div class="openrouter-route-columns openrouter-route-grid" aria-hidden="true">
                      <span>{t("provider.picker.openrouterProviderColumn")}</span>
                      <span>{t("provider.picker.openrouterPriceInput")}</span>
                      <span>{t("provider.picker.openrouterPriceOutput")}</span>
                    </div>
                    <For
                      each={options()}
                      fallback={
                        <div class="openrouter-route-message">
                          {catalog().noTraining
                            ? t("provider.picker.openrouterNoTrainingMatches")
                            : t("provider.picker.openrouterNoProviders")}
                        </div>
                      }
                    >
                      {(route) => (
                        <Button
                          variant="ghost"
                          class="openrouter-route-grid openrouter-route-item"
                          aria-pressed={catalog().current === route.provider ? "true" : "false"}
                          disabled={blocked()}
                          onClick={() => void save(route.provider, catalog().noTraining)}
                        >
                          <span class="openrouter-route-name">
                            <strong>
                              {route.name}
                              <Show when={catalog().current === route.provider}>
                                <Check />
                              </Show>
                            </strong>
                            <small>
                              {route.provider}
                              {" · "}
                              {route.trainsOnData === null
                                ? t("provider.picker.openrouterTrainingUnknown")
                                : route.trainsOnData
                                  ? t("provider.picker.openrouterTrains")
                                  : t("provider.picker.openrouterDoesNotTrain")}
                            </small>
                          </span>
                          <span>
                            <span class="sr-only">{t("provider.picker.openrouterPriceInput")} </span>
                            {price(route.promptPerMillion)}
                          </span>
                          <span>
                            <span class="sr-only">{t("provider.picker.openrouterPriceOutput")} </span>
                            {price(route.completionPerMillion)}
                          </span>
                        </Button>
                      )}
                    </For>
                  </div>
                  <Show when={saveFailed()}>
                    <div class="openrouter-route-message" role="alert">
                      {t("provider.picker.openrouterSaveFailed")}
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

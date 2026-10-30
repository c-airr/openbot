import type { FreeLlmBudget, FreeLlmBudgetModel, FreeLlmBudgetProvider } from "@openbot/contracts/ipc";
import { usageRemainingPercent, usageTone } from "@openbot/team-client/plan-limits";
import { Button, Dialog, Gauge, IconButton, Input, X } from "@openbot/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { useText } from "../../text";
import { AccountUsageWindowList } from "../account/AccountUsageDetails";
import { type AccountUsageWindowRow, formatUsageReset } from "../account/account-usage-view";

type Text = ReturnType<typeof useText>;

const SOURCE_KEY = {
  official: "account.freeLlm.source.official",
  learned: "account.freeLlm.source.learned",
  estimate: "account.freeLlm.source.estimate",
} as const;

/** Fork: the share of today's FreeLLMAPI budget used, over the providers that publish a daily limit. */
export function freeLlmUsedPercent(budget: FreeLlmBudget): number {
  const limited = budget.providers.filter((provider) => provider.tokensPerDay);
  const perDay = limited.reduce((sum, provider) => sum + (provider.tokensPerDay ?? 0), 0);
  const left = limited.reduce((sum, provider) => sum + (provider.tokensLeft ?? 0), 0);
  return perDay ? Math.round(100 - (left / perDay) * 100) : 0;
}

function tokenWindow(row: FreeLlmBudgetProvider, resetsAt: number, text: Text): AccountUsageWindowRow {
  const used = row.tokensPerDay ? Math.min(100, Math.round(100 - ((row.tokensLeft ?? 0) / row.tokensPerDay) * 100)) : 0;
  const remainingPercent = usageRemainingPercent(used);
  return {
    label: row.tokensPerDay
      ? text.t("account.freeLlm.tokensLeft", {
          left: text.format.compact(row.tokensLeft ?? 0),
          perDay: text.format.compact(row.tokensPerDay),
        })
      : text.t("account.freeLlm.tokensToday", { today: text.format.compact(row.tokensToday) }),
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    tone: row.tokensPerDay ? usageTone(remainingPercent) : "neutral",
    resetsAt,
    resetsAtLabel: formatUsageReset(resetsAt, text),
  };
}

function requestWindow(model: FreeLlmBudgetModel, resetsAt: number, text: Text): AccountUsageWindowRow[] {
  if (!model.requestsPerDay) return [];
  const remainingPercent = usageRemainingPercent(
    Math.min(100, Math.round(100 - ((model.requestsLeft ?? 0) / model.requestsPerDay) * 100)),
  );
  return [
    {
      label: text.t("account.freeLlm.requestsLeft", {
        left: text.format.number(model.requestsLeft ?? 0),
        perDay: text.format.number(model.requestsPerDay),
      }),
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      tone: usageTone(remainingPercent),
      resetsAt,
      resetsAtLabel: formatUsageReset(resetsAt, text),
    },
  ];
}

function useClock() {
  const [now, setNow] = createSignal(Date.now());
  const clock = window.setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => window.clearInterval(clock));
  return now;
}

/** The hover card of the rail button: what each provider has left today. */
export function FreeLlmBudgetCard(props: { budget: FreeLlmBudget }) {
  const text = useText();
  const now = useClock();
  return (
    <>
      <header class="account-usage-popover-header">
        <div class="account-usage-popover-heading">
          <Gauge aria-hidden="true" />
          <h2 class="account-usage-popover-title">{text.t("account.freeLlm.title")}</h2>
        </div>
      </header>
      <ul class="account-usage-providers" aria-label={text.t("account.freeLlm.providers")}>
        <For each={props.budget.providers} keyed={(provider) => provider.platform}>
          {(provider) => (
            <li class="account-usage-provider">
              <strong class="account-usage-provider-name">{provider().platform}</strong>
              <AccountUsageWindowList windows={[tokenWindow(provider(), props.budget.resetsAt, text)]} now={now()} />
            </li>
          )}
        </For>
      </ul>
      <p class="account-usage-empty">{text.t("account.freeLlm.openHint")}</p>
    </>
  );
}

/** Every model of the chain, smartest first, with the tokens and requests it has left today. */
export function FreeLlmBudgetDialog(props: {
  budget: FreeLlmBudget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const text = useText();
  const now = useClock();
  const [query, setQuery] = createSignal("");
  const [platform, setPlatform] = createSignal<string | null>(null);
  const models = () => {
    const search = query().trim().toLowerCase();
    return (props.budget?.models ?? []).filter(
      (model) =>
        (!platform() || model.platform === platform()) &&
        (!search || `${model.name} ${model.platform} ${model.modelId}`.toLowerCase().includes(search)),
    );
  };
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="custom-provider-backdrop provider-more-backdrop">
          <Dialog.Content as="section" class="custom-provider-dialog provider-more-dialog free-llm-dialog">
            <header class="provider-more-header">
              <Dialog.Title as="h2" class="provider-more-title">
                {text.t("account.freeLlm.title")}
              </Dialog.Title>
              <IconButton label={text.t("common.close")} variant="ghost" onClick={() => props.onOpenChange(false)}>
                <X />
              </IconButton>
            </header>
            <Show when={props.budget}>
              {(budget) => (
                <>
                  <p class="account-usage-empty">
                    {text.t("account.freeLlm.resets", { time: formatUsageReset(budget().resetsAt, text) ?? "" })}
                  </p>
                  <div class="free-llm-platforms">
                    <For each={budget().providers} keyed={(provider) => provider.platform}>
                      {(provider) => (
                        <Button
                          type="button"
                          variant={platform() === provider().platform ? "secondary" : "ghost"}
                          size="sm"
                          aria-pressed={platform() === provider().platform ? "true" : "false"}
                          onClick={() => setPlatform(platform() === provider().platform ? null : provider().platform)}
                        >
                          {provider().platform}
                        </Button>
                      )}
                    </For>
                  </div>
                  <Input
                    type="search"
                    class="provider-more-search"
                    placeholder={text.t("account.freeLlm.search")}
                    aria-label={text.t("account.freeLlm.search")}
                    autocomplete="off"
                    value={query()}
                    onValueChange={setQuery}
                  />
                  <ul class="account-usage-providers free-llm-models" aria-label={text.t("account.freeLlm.models")}>
                    <For each={models()} keyed={(model) => `${model.platform}|${model.modelId}`}>
                      {(model) => (
                        <li class="account-usage-provider">
                          <span class="account-usage-provider-copy">
                            <strong class="account-usage-provider-name">{model().name}</strong>
                            <span class="account-usage-provider-meta">
                              {text.t("account.freeLlm.modelMeta", {
                                platform: model().platform,
                                rank: model().rank ?? "?",
                                source: text.t(SOURCE_KEY[model().source]),
                              })}
                            </span>
                          </span>
                          <AccountUsageWindowList
                            windows={[
                              tokenWindow(model(), budget().resetsAt, text),
                              ...requestWindow(model(), budget().resetsAt, text),
                            ]}
                            now={now()}
                          />
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={models().length === 0}>
                    <p class="provider-more-empty">{text.t("account.freeLlm.noMatch")}</p>
                  </Show>
                </>
              )}
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

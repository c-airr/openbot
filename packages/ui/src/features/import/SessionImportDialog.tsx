import { ProviderLogo, type ProviderLogoVariant } from "@openbot/brand";
import { isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import type {
  ApplySessionImportInput,
  ClientAgentModelOption,
  ImportableSession,
  SessionImportMode,
  SessionImportResult,
  SessionImportSource,
} from "@openbot/contracts/ipc";
import { Button, Check, Checkbox, Dialog, IconButton, Input, NativeSelect, Textarea, X } from "@openbot/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useText } from "../../text";

export interface SessionImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while main reads the apps' folders. */
  sessions: ImportableSession[] | null;
  models: readonly ClientAgentModelOption[];
  busy: boolean;
  result: SessionImportResult | null;
  error: string | null;
  onImport: (input: ApplySessionImportInput) => void;
}

/** One chip per app. The two Cursor stores share a chip and a logo. */
const APPS: ReadonlyArray<{ id: ProviderLogoVariant; name: string; sources: readonly SessionImportSource[] }> = [
  { id: "cursor", name: "Cursor", sources: ["cursor-cli", "cursor-ide"] },
  { id: "codex", name: "Codex", sources: ["codex"] },
  { id: "claude", name: "Claude Code", sources: ["claude"] },
  { id: "opencode", name: "OpenCode", sources: ["opencode"] },
];

const logoOf = (source: SessionImportSource): ProviderLogoVariant =>
  APPS.find((app) => app.sources.includes(source))?.id ?? "unknown";

const MODES: readonly SessionImportMode[] = ["resume", "paste", "compact"];

const folderName = (cwd: string | null) => cwd?.split(/[\\/]/u).filter(Boolean).pop() ?? "";

/**
 * Fork: Import sessions. A list of what Cursor, Codex, Claude Code and OpenCode keep on this
 * computer, picked like files in an explorer, then turned into chats in one of three ways.
 */
export function SessionImportDialog(props: SessionImportDialogProps) {
  const { t } = useText();
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<SessionImportMode>("paste");
  const [prompt, setPrompt] = createSignal("");
  const [modelKey, setModelKey] = createSignal("");

  const visible = createMemo(() => {
    const text = query().trim().toLowerCase();
    return (props.sessions ?? []).filter((session) => {
      if (hidden().has(logoOf(session.source))) return false;
      return !text || `${session.title} ${session.cwd ?? ""}`.toLowerCase().includes(text);
    });
  });
  const chosen = createMemo(() => (props.sessions ?? []).filter((session) => selected().has(session.key)));
  const canResume = () => chosen().length > 0 && chosen().every((session) => session.resumable);
  const effectiveMode = (): SessionImportMode => (mode() === "resume" && !canResume() ? "paste" : mode());
  const models = createMemo(() => props.models.filter((model) => isKnownAgentProvider(model.provider)));
  const selectedModel = () => models().find((model) => `${model.provider}/${model.id}` === modelKey());

  function toggleApp(id: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Click toggles one row; shift-click takes the whole run from the last click, as in a file explorer. */
  function pick(key: string, extend: boolean) {
    const rows = visible();
    const from = extend && anchor() ? rows.findIndex((row) => row.key === anchor()) : -1;
    const to = rows.findIndex((row) => row.key === key);
    setSelected((current) => {
      const next = new Set(current);
      if (from >= 0 && to >= 0) {
        for (const row of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(row.key);
      } else if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
    setAnchor(key);
  }

  const allVisibleSelected = () => visible().length > 0 && visible().every((row) => selected().has(row.key));
  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visible()) {
        if (allVisibleSelected()) next.delete(row.key);
        else next.add(row.key);
      }
      return next;
    });
  }

  function submit() {
    const model = selectedModel();
    props.onImport({
      keys: chosen().map((session) => session.key),
      mode: effectiveMode(),
      prompt: prompt(),
      ...(effectiveMode() === "compact" && model && isKnownAgentProvider(model.provider)
        ? { provider: model.provider, model: model.id }
        : {}),
    });
  }

  const modeLabel = (value: SessionImportMode) => t(`import.sessions.mode.${value}`);

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="custom-provider-backdrop session-import-backdrop">
          <Dialog.Content as="section" class="custom-provider-dialog session-import-dialog">
            <header class="session-import-header">
              <div>
                <Dialog.Title as="h2" class="provider-more-title">
                  {t("import.sessions.title")}
                </Dialog.Title>
                <p class="session-import-lede">{t("import.sessions.lede")}</p>
              </div>
              <IconButton label={t("common.close")} variant="ghost" onClick={() => props.onOpenChange(false)}>
                <X />
              </IconButton>
            </header>

            <div class="session-import-filters">
              <For each={APPS}>
                {(app) => (
                  <Button
                    type="button"
                    variant="ghost"
                    class="session-import-chip"
                    aria-pressed={hidden().has(app.id) ? "false" : "true"}
                    onClick={() => toggleApp(app.id)}
                  >
                    <ProviderLogo provider={app.id} class="session-import-logo" />
                    {app.name}
                  </Button>
                )}
              </For>
              <Input
                type="search"
                class="session-import-search"
                placeholder={t("import.sessions.search")}
                aria-label={t("import.sessions.search")}
                autocomplete="off"
                value={query()}
                onValueChange={setQuery}
              />
            </div>

            <div class="session-import-listhead">
              <div class="session-import-all">
                <Checkbox
                  checked={allVisibleSelected()}
                  onChange={toggleAll}
                  aria-label={t("import.sessions.selectAll")}
                />
                <span>{t("import.sessions.selectAll")}</span>
              </div>
              <span>{t("import.sessions.selected", { count: chosen().length })}</span>
            </div>

            <div class="session-import-list">
              <Show when={props.sessions} fallback={<p class="provider-more-empty">{t("import.sessions.loading")}</p>}>
                <For each={visible()} keyed={false}>
                  {(session) => (
                    <Button
                      type="button"
                      variant="ghost"
                      class="session-import-row"
                      aria-pressed={selected().has(session().key) ? "true" : "false"}
                      onClick={(event) => pick(session().key, event.shiftKey)}
                    >
                      <span class="session-import-check" aria-hidden="true">
                        <Show when={selected().has(session().key)}>
                          <Check />
                        </Show>
                      </span>
                      <ProviderLogo provider={logoOf(session().source)} class="session-import-logo" />
                      <span class="session-import-text">
                        <span class="session-import-name">{session().title}</span>
                        <small class="session-import-meta">
                          {session().source === "cursor-ide"
                            ? "IDE · "
                            : session().source === "cursor-cli"
                              ? "CLI · "
                              : ""}
                          {new Date(session().updatedAt).toLocaleDateString()}
                          {folderName(session().cwd) ? ` · ${folderName(session().cwd)}` : ""}
                        </small>
                      </span>
                    </Button>
                  )}
                </For>
                <Show when={visible().length === 0}>
                  <p class="provider-more-empty">{t("import.sessions.empty")}</p>
                </Show>
              </Show>
            </div>

            <footer class="session-import-footer">
              <div class="session-import-modes">
                <For each={MODES}>
                  {(value) => (
                    <Button
                      type="button"
                      variant="ghost"
                      class="session-import-mode"
                      aria-pressed={effectiveMode() === value ? "true" : "false"}
                      disabled={value === "resume" && !canResume()}
                      onClick={() => setMode(value)}
                    >
                      <span class="session-import-mode-title">{modeLabel(value)}</span>
                      <small>{t(`import.sessions.mode.${value}Note`)}</small>
                    </Button>
                  )}
                </For>
              </div>
              <Show when={effectiveMode() !== "resume"}>
                <Textarea
                  class="session-import-prompt"
                  rows={2}
                  placeholder={t(`import.sessions.prompt.${effectiveMode() === "compact" ? "compact" : "paste"}`)}
                  value={prompt()}
                  onValueChange={setPrompt}
                />
              </Show>
              <Show when={effectiveMode() === "compact"}>
                <NativeSelect
                  aria-label={t("import.sessions.model")}
                  value={modelKey()}
                  onChange={(event) => setModelKey(event.currentTarget.value)}
                >
                  <option value="">{t("import.sessions.modelDefault")}</option>
                  <For each={models()}>
                    {(model) => (
                      <option value={`${model.provider}/${model.id}`}>
                        {model.provider} · {model.name}
                      </option>
                    )}
                  </For>
                </NativeSelect>
              </Show>
              <Show when={props.error}>{(message) => <p class="session-import-error">{message()}</p>}</Show>
              <Show when={props.result}>
                {(result) => (
                  <p class="session-import-result">
                    {t("import.sessions.done", { count: result().agentIds.length })}
                    <Show when={result().failed.length > 0}>
                      {` · ${t("import.sessions.failed", { count: result().failed.length })}: ${result()
                        .failed.map((failure) => failure.message)
                        .join("; ")}`}
                    </Show>
                  </p>
                )}
              </Show>
              <div class="session-import-actions">
                <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
                  {t("common.close")}
                </Button>
                <Button type="button" disabled={props.busy || chosen().length === 0} onClick={submit}>
                  {props.busy ? t("import.sessions.importing") : t("import.sessions.import")}
                </Button>
              </div>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

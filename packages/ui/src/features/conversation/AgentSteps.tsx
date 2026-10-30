import type { ConversationMemoryChange, ConversationTraceToolKind } from "@openbot/contracts/ipc";
import { countConversationMemoryChanges } from "@openbot/contracts/ipc";
import { Dynamic, type JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { Badge } from "../../badge";
import { Button } from "../../button";
import {
  Bot,
  Brain,
  ChevronRight,
  FileText,
  Globe2,
  Pencil,
  Plug,
  Puzzle,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "../../icons";
import { type TextValue, useText } from "../../text";
import { prefersReducedMotion } from "../../utils";
import { useDuration } from "./Subagents";
import { type TraceKeyboard, type TraceSpan, TraceWaterfallDialog } from "./TraceWaterfall";

/**
 * One step of an agent's turn: a thought, a progress line of the host, or a memory change that the
 * turn committed. `memory-summary` is the count that a host without the changes sends instead.
 * The text of `progress` and `memory-summary` is the host's English source text.
 */
export type AgentStep =
  | { id: string; kind: "thinking"; text: string }
  | AgentProgressStep
  | { id: string; kind: "tools"; steps: AgentProgressStep[] }
  | { id: string; kind: "memory"; change: ConversationMemoryChange }
  | { id: string; kind: "memory-summary"; text: string };

/**
 * A progress line of the host. Fork: a tool step of a stored trace also says what ran: its kind, and
 * the command, file, query or tool it worked on.
 */
export interface AgentProgressStep {
  id: string;
  kind: "progress";
  text: string;
  tool?: { kind: ConversationTraceToolKind | null; detail: string | null; failed: boolean } | undefined;
}

/**
 * Fork: the tool steps of a stored trace as one row each run, as Claude Code shows its tool calls:
 * "Ran 2 commands, read 1 file", which opens to each command, file and query. A progress line
 * with no tool (a live line, or a turn from before) stays a line.
 */
export function groupToolSteps(steps: readonly AgentStep[]): AgentStep[] {
  const grouped: AgentStep[] = [];
  for (const step of steps) {
    const last = grouped.at(-1);
    if (step.kind !== "progress" || !step.tool) grouped.push(step);
    else if (last?.kind === "tools") last.steps.push(step);
    else grouped.push({ id: step.id, kind: "tools", steps: [step] });
  }
  return grouped;
}

const TOOL_COUNT_LABEL = {
  command: "chat.tools.command",
  file_read: "chat.tools.fileRead",
  file_change: "chat.tools.fileChange",
  web_search: "chat.tools.webSearch",
  web_fetch: "chat.tools.webFetch",
  mcp: "chat.tools.mcp",
  subagent: "chat.tools.subagent",
  other: "chat.tools.other",
} as const;

const TOOL_ICON = {
  command: Terminal,
  file_read: FileText,
  file_change: Pencil,
  web_search: Search,
  web_fetch: Globe2,
  mcp: Plug,
  subagent: Bot,
  other: Puzzle,
} as const;

/** "Ran 2 commands, read 1 file", in the order the kinds first ran. */
function toolsSummary(steps: readonly AgentProgressStep[], text: TextValue): string {
  const counts = new Map<ConversationTraceToolKind, number>();
  for (const step of steps) {
    const kind = step.tool?.kind ?? "other";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const summary = text.format.list([...counts].map(([kind, count]) => text.t(TOOL_COUNT_LABEL[kind], { count })));
  const failed = steps.filter((step) => step.tool?.failed).length;
  const line = summary.charAt(0).toLocaleUpperCase() + summary.slice(1);
  return failed > 0 ? `${line} · ${text.t("chat.steps.failed", { count: failed })}` : line;
}

/** One run of tool steps: a summary that opens to each step's command, file, query or tool. */
function ToolGroup(props: { steps: readonly AgentProgressStep[]; newest: boolean }) {
  const text = useText();
  const [open, setOpen] = createSignal(false);
  const panelId = createUniqueId();
  return (
    <span class="agent-step-tools" data-open={open() ? "" : undefined}>
      <Button
        type="button"
        variant="ghost"
        class={["agent-step-tools-header", { "agent-activity-label": props.newest }]}
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? panelId : undefined}
        onClick={() => setOpen(!open())}
      >
        <span class="agent-step-text">{toolsSummary(props.steps, text)}</span>
        <ChevronRight class="agent-steps-chevron" aria-hidden="true" />
      </Button>
      <Show when={open()}>
        <ul id={panelId} class="agent-step-tools-list">
          <For each={props.steps} keyed={(step) => step.id}>
            {(step) => (
              <li class="agent-step-tool" data-failed={step().tool?.failed ? "" : undefined}>
                <Dynamic
                  component={TOOL_ICON[step().tool?.kind ?? "other"]}
                  class="agent-step-icon"
                  aria-hidden="true"
                />
                <span class={step().tool?.kind === "command" ? "agent-step-tool-command" : "agent-step-tool-detail"}>
                  {step().tool?.detail ?? text.sourceText(step().text)}
                </span>
                <Show when={step().tool?.failed}>
                  <Badge class="agent-steps-failed">{text.t("chat.tools.error")}</Badge>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </span>
  );
}

/** How tall the list grows before it scrolls, and before a live list glides to its newest step. */
const STEPS_MAX_HEIGHT = 220;

const MEMORY_ACTION_LABEL = {
  saved: "chat.steps.saved",
  updated: "chat.steps.updated",
  forgotten: "chat.steps.forgotten",
  notChanged: "chat.steps.notChanged",
} as const;

/**
 * The steps of a turn, in order. While the turn runs, `live` marks the newest step and the list
 * glides so that step stays at the bottom edge; after the turn the list scrolls.
 */
export function AgentStepList(props: {
  steps: readonly AgentStep[];
  live: boolean;
  id?: string;
  /** The step to scroll to and light up, such as the one that the user picked in the trace. */
  focus?: { id: string } | null | undefined;
}) {
  const { t } = useText();
  const [contentHeight, setContentHeight] = createSignal(0);
  let content: HTMLOListElement | undefined;
  onSettled(() => {
    const element = content;
    if (!element) return;
    const observer = new ResizeObserver(() => setContentHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  });
  createEffect(
    () => props.focus,
    (focus) => {
      if (!focus) return;
      const step = content?.querySelector(`[data-step-id="${CSS.escape(focus.id)}"]`);
      step?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    },
  );
  const capped = () => contentHeight() > STEPS_MAX_HEIGHT;
  const scrolls = () => !props.live && capped();
  const offset = () => (props.live && capped() ? STEPS_MAX_HEIGHT - contentHeight() : 0);
  return (
    <section
      id={props.id}
      class="agent-steps-viewport"
      aria-label={t("chat.steps.list")}
      data-capped={capped() ? "" : undefined}
      data-scrolls={scrolls() ? "" : undefined}
      // A list that scrolls needs a keyboard stop of its own.
      tabindex={scrolls() ? 0 : undefined}
    >
      <ol ref={content} class="agent-steps-list" style={{ transform: `translateY(${offset()}px)` }}>
        <For each={props.steps} keyed={(step) => step.id}>
          {(step, index) => (
            <li
              class="agent-step"
              data-kind={step().kind}
              data-step-id={step().id}
              data-focused={props.focus?.id === step().id ? "" : undefined}
            >
              <StepIcon kind={step().kind} />
              <StepBody step={step()} newest={props.live && index() === props.steps.length - 1} />
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}

function StepBody(props: { step: AgentStep; newest: boolean }) {
  const text = useText();
  return <>{stepBody(props.step, props.newest, text)}</>;
}

function stepBody(step: AgentStep, newest: boolean, text: TextValue): JSX.Element {
  if (step.kind === "tools") return <ToolGroup steps={step.steps} newest={newest} />;
  if (step.kind === "memory") {
    const change = step.change;
    return (
      <span class="agent-step-memory" data-action={change.action}>
        <span class="agent-step-memory-action">{text.t(MEMORY_ACTION_LABEL[change.action])}</span>
        <Show when={change.previousText}>{(previous) => <s class="agent-step-memory-previous">{previous()}</s>}</Show>
        {change.action === "forgotten" ? <s>{change.text}</s> : <span>{change.text}</span>}
      </span>
    );
  }
  const shown = step.kind === "thinking" ? step.text : text.sourceText(step.text);
  return <span class={["agent-step-text", { "agent-activity-label": newest }]}>{shown}</span>;
}

function StepIcon(props: { kind: AgentStep["kind"] }) {
  return (
    <>
      {props.kind === "thinking" ? (
        <Sparkles class="agent-step-icon" aria-hidden="true" />
      ) : props.kind === "progress" ? (
        <Puzzle class="agent-step-icon" aria-hidden="true" />
      ) : props.kind === "tools" ? (
        <Wrench class="agent-step-icon" aria-hidden="true" />
      ) : (
        <Brain class="agent-step-icon" aria-hidden="true" />
      )}
    </>
  );
}

/** The one-line summary of a finished turn's steps: "9 steps · Memory: 2 saved and 1 forgotten". */
function stepsSummary(steps: readonly AgentStep[], text: TextValue): string {
  const work = steps.reduce(
    (sum, step) =>
      sum + (step.kind === "tools" ? step.steps.length : step.kind === "thinking" || step.kind === "progress" ? 1 : 0),
    0,
  );
  const changes = steps.flatMap((step) => (step.kind === "memory" ? [step.change] : []));
  const counts = countConversationMemoryChanges(changes);
  const memory = text.format.list(
    [
      counts.saved ? text.t("chat.steps.memorySaved", { count: counts.saved }) : null,
      counts.updated ? text.t("chat.steps.memoryUpdated", { count: counts.updated }) : null,
      counts.forgotten ? text.t("chat.steps.memoryForgotten", { count: counts.forgotten }) : null,
      counts.notChanged ? text.t("chat.steps.memoryNotChanged", { count: counts.notChanged }) : null,
    ].filter((part): part is string => part !== null),
  );
  const fallback = steps.find((step) => step.kind === "memory-summary");
  return [
    work > 0 ? text.t("chat.steps.count", { count: work }) : null,
    changes.length > 0 ? text.t("chat.steps.memory", { changes: memory }) : null,
    fallback?.kind === "memory-summary" ? text.sourceText(fallback.text) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** The trace of a turn, which its steps row opens in a dialog. */
export interface AgentStepsTrace {
  /** Read only while the dialog is open. */
  spans: () => readonly TraceSpan[];
  keyboard: TraceKeyboard;
  /** The spans that are not steps of the list but that the chat can show, such as subagents. */
  canSelectSpan?: (id: string) => boolean;
  onSelectSpan?: (id: string) => void;
}

/** The facts of a finished turn that its steps row shows. */
export interface AgentStepsFacts {
  durationMs: number;
  /** The steps and subagents that failed. */
  failed: number;
}

/**
 * The steps of a finished turn, above its answer: a closed summary row that opens the list, and in
 * the list a button that opens the trace when the turn has one. The row looks like the header of the
 * subagents above it. The "Show agent steps" setting opens the list at first.
 */
export function AgentStepsDisclosure(props: {
  steps: readonly AgentStep[];
  defaultOpen: boolean;
  trace?: AgentStepsTrace | undefined;
  facts?: AgentStepsFacts | undefined;
}) {
  const text = useText();
  const duration = useDuration();
  /** Whole seconds, rounded as the trace rounds the turn, so that the row and the trace agree. */
  const turnTime = (ms: number) => duration(Math.round(ms / 1_000) * 1_000);
  const panelId = createUniqueId();
  const [choice, setChoice] = createSignal<boolean>();
  // The time the trace opened: a finished turn does not move, so its "now" stays at that time.
  const [traceOpenedAt, setTraceOpenedAt] = createSignal<number | null>(null);
  // A long chat has a row for each turn, so a row builds its trace dialog when it first opens.
  const [traceUsed, setTraceUsed] = createSignal(false);
  const open = () => choice() ?? props.defaultOpen;
  // The step that the user picked in the trace. A new object each time scrolls to it again.
  const [focus, setFocus] = createSignal<{ id: string } | null>(null);
  const isStep = (id: string) => props.steps.some((step) => step.id === id);
  const canSelectSpan = (id: string) => isStep(id) || (props.trace?.canSelectSpan?.(id) ?? false);
  /** Closes the trace and shows the step in the list, or lets the chat show it. */
  const selectSpan = (id: string) => {
    setTraceOpenedAt(null);
    if (!isStep(id)) {
      props.trace?.onSelectSpan?.(id);
      return;
    }
    setChoice(true);
    setFocus({ id });
  };
  /** Fork: the row opens the list, so the tool steps show; the trace opens from a button in the list. */
  const openTrace = () => {
    setTraceUsed(true);
    setTraceOpenedAt(Date.now());
  };
  const activate = () => {
    setFocus(null);
    setChoice(!open());
  };
  return (
    <div class="agent-steps" data-open={open() ? "" : undefined}>
      <Button
        type="button"
        variant="ghost"
        class="agent-steps-header"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? panelId : undefined}
        onClick={activate}
      >
        <span class="agent-steps-summary">{stepsSummary(props.steps, text)}</span>
        <Show when={props.facts}>
          {(facts) => (
            <>
              <Show when={facts().failed > 0}>
                <Badge class="agent-steps-failed">{text.t("chat.steps.failed", { count: facts().failed })}</Badge>
              </Show>
              <span class="agent-steps-duration">{turnTime(facts().durationMs)}</span>
            </>
          )}
        </Show>
        <ChevronRight class="agent-steps-chevron" aria-hidden="true" />
      </Button>
      <Show when={traceUsed() && props.trace}>
        {(trace) => {
          // The waterfall reads its spans many times for each change; this builds them once.
          const spans = createMemo(() => trace().spans());
          return (
            <TraceWaterfallDialog
              open={traceOpenedAt() !== null}
              onOpenChange={(next) => {
                if (!next) setTraceOpenedAt(null);
              }}
              spans={spans()}
              now={traceOpenedAt() ?? 0}
              keyboard={trace().keyboard}
              canSelectSpan={canSelectSpan}
              onSelectSpan={selectSpan}
            />
          );
        }}
      </Show>
      {/* A long chat has a row for each turn, so a closed row builds no list. */}
      <Show when={open()}>
        <div class="agent-steps-panel">
          <AgentStepList id={panelId} steps={props.steps} live={false} focus={focus()} />
          <Show when={props.trace}>
            <Button type="button" variant="ghost" size="sm" class="agent-steps-trace" onClick={openTrace}>
              {text.t("chat.steps.openTrace")}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

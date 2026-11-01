import type { ConversationSubagent } from "@openbot/contracts/ipc";
import { createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import { useText } from "../../text";
import { createTaskListPlayState, TaskListHeader, TaskMark } from "./TaskList";

export interface RunningSubagentsProps {
  /** The subagents that work now. */
  items: readonly ConversationSubagent[];
  /** The list starts collapsed when this is false. */
  defaultOpen?: boolean;
}

/** What a subagent did last: the text of its newest step. */
function lastStep(subagent: ConversationSubagent): string {
  return subagent.steps.at(-1)?.text.replace(/\s+/gu, " ").trim() ?? "";
}

/**
 * Fork: the subagents that work now, one row for each, above the composer, as the terminal agents
 * list them under the prompt. It has the card of "Open waits", and it renders nothing when none runs.
 */
export function RunningSubagents(props: RunningSubagentsProps) {
  return (
    <Show when={props.items.length > 0}>
      <RunningSubagentList {...props} />
    </Show>
  );
}

function RunningSubagentList(props: RunningSubagentsProps) {
  const { t } = useText();
  const panelId = createUniqueId();
  const playState = createTaskListPlayState();
  const [open, setOpen] = createSignal(untrack(() => props.defaultOpen ?? true));
  const total = () => props.items.length;
  const leadLabel = () => {
    const one = props.items[0];
    return one ? [one.title, lastStep(one)].filter(Boolean).join(": ") : "";
  };
  return (
    <section
      style={{ "--task-list-play-state": playState() }}
      class="task-list awaiting-replies open-waits"
      data-open={open() ? "" : undefined}
      aria-label={t("chat.subagents.running.label")}
    >
      <div class="awaiting-replies-bar">
        <TaskListHeader
          open={open()}
          onToggle={() => setOpen((value) => !value)}
          panelId={panelId}
          done={0}
          total={total()}
          title={t("chat.subagents.running.title", { count: total() })}
          active={{ id: props.items[0]?.id ?? "", label: leadLabel() }}
          summary=""
          count=""
        />
      </div>
      <div id={panelId} class="task-list-panel" inert={open() ? undefined : true}>
        <ol class="task-list-items">
          <For each={props.items} keyed={(item) => item.id}>
            {(item, index) => (
              <li class="task-list-item open-waits-row" data-state="active" style={{ "--task-list-index": index() }}>
                <span class="task-list-item-mark" aria-hidden="true">
                  <TaskMark state="active" />
                </span>
                <span class="open-waits-row-text">
                  <span class="open-waits-row-note">{item().title}</span>
                  <span class="open-waits-row-meta">
                    <span class="open-waits-row-state">{t("chat.subagents.state.running")}</span>
                    <Show when={lastStep(item())}>
                      {(step) => (
                        <>
                          <span aria-hidden="true">·</span>
                          <span class="open-waits-row-request">{step()}</span>
                        </>
                      )}
                    </Show>
                  </span>
                </span>
              </li>
            )}
          </For>
        </ol>
      </div>
    </section>
  );
}

import { Dialog } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { AgentMemoriesSettings } from "../conversation/AgentMemoriesSettings";
import { sharedMemoriesPort } from "../conversation/memories-port";
import { setSharedMemoryOpen, sharedMemoryOpen } from "./shared-memory-state";

/** Fork: the memories every chat gets, in a window around the page that a chat's own memories use. */
export function SharedMemoryOverlay() {
  const { t } = useText();
  const close = () => setSharedMemoryOpen(false);
  return (
    <Dialog.Root open={sharedMemoryOpen()} onOpenChange={setSharedMemoryOpen}>
      <Dialog.Portal>
        <Dialog.Overlay class="agent-memories-overlay" />
        <Dialog.Content class="agent-memories-modal">
          <Dialog.Title class="sr-only">{t("memory.title")}</Dialog.Title>
          <Dialog.Description class="sr-only">
            {t("memory.description", { name: t("memory.shared.owner") })}
          </Dialog.Description>
          <AgentMemoriesSettings
            port={sharedMemoriesPort(t("memory.shared.owner"))}
            open={sharedMemoryOpen()}
            onBack={close}
            onClose={close}
            onCountChange={() => undefined}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

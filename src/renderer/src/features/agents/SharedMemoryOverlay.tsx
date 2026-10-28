import { useText } from "@openbot/ui/text";
import { AgentMemoriesModal } from "../conversation/AgentMemoriesModal";
import { sharedMemoriesPort } from "../conversation/memories-port";
import { setSharedMemoryOpen, sharedMemoryOpen } from "./shared-memory-state";

/** Fork: the memories every chat gets, in the same window as a chat's own. */
export function SharedMemoryOverlay() {
  const { t } = useText();
  return (
    <AgentMemoriesModal
      port={sharedMemoriesPort(t("memory.shared.owner"))}
      open={sharedMemoryOpen()}
      onOpenChange={setSharedMemoryOpen}
      onCountChange={() => undefined}
    />
  );
}

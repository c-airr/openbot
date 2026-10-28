import type { ImportableSession, SessionImportResult } from "@openbot/contracts/ipc";
import { SessionImportDialog } from "@openbot/ui/features/import/SessionImportDialog";
import { currentText } from "@openbot/ui/text";
import { createEffect, createSignal } from "solid-js";
import { useAgentActions } from "./agent-actions";
import { useAgents } from "./agents-context";
import { agentsPort } from "./agents-port";
import { sessionImportOpen, setSessionImportOpen } from "./session-import-state";

/** Fork: the Import sessions dialog. It reads the sessions each time it opens, so a new one shows up. */
export function SessionImportOverlay() {
  const { importSessions } = useAgentActions();
  const { modelOptions } = useAgents();
  const [sessions, setSessions] = createSignal<ImportableSession[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<SessionImportResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  // A plain flag: a signal set on the first click is not read back until the next flush, so a quick
  // second click would start the same import again.
  let running = false;

  createEffect(sessionImportOpen, (open) => {
    if (!open) return;
    setSessions(null);
    setResult(null);
    setError(null);
    void agentsPort()
      .listImportableSessions()
      .then(setSessions)
      .catch(() => {
        setSessions([]);
        setError(currentText().t("import.sessions.loadFailed"));
      });
  });

  return (
    <SessionImportDialog
      open={sessionImportOpen()}
      onOpenChange={setSessionImportOpen}
      sessions={sessions()}
      models={modelOptions()}
      busy={busy()}
      result={result()}
      error={error()}
      onImport={(input) => {
        if (running) return;
        running = true;
        setBusy(true);
        setError(null);
        setResult(null);
        importSessions(input)
          .then((outcome) => {
            // All done: the chats are in the list, so the dialog goes. A failure keeps it open to show why.
            if (outcome.failed.length === 0) setSessionImportOpen(false);
            else setResult(outcome);
          })
          .catch((failure: unknown) => {
            const { t, errorMessage } = currentText();
            setError(errorMessage(failure, t("import.sessions.loadFailed")));
          })
          .finally(() => {
            running = false;
            setBusy(false);
          });
      }}
    />
  );
}

import { createSignal } from "solid-js";

const STORAGE_KEY = "openbot.discord-presence.enabled";

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

const [enabled, setEnabled] = createSignal(readPreference());

export function discordPresenceEnabled(): boolean {
  return enabled();
}

export function setDiscordPresenceEnabled(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Keep the setting for this window when storage is unavailable.
  }
  setEnabled(value);
}

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) setEnabled(readPreference());
});

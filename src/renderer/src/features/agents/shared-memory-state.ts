import { createSignal } from "solid-js";

/** Fork: whether the shared memory window is open. Opened from the sidebar menu. */
export const [sharedMemoryOpen, setSharedMemoryOpen] = createSignal(false);

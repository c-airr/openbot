import { createSignal } from "solid-js";

/** Fork: whether the Import sessions dialog is open. One dialog per window, opened from the sidebar menu. */
export const [sessionImportOpen, setSessionImportOpen] = createSignal(false);

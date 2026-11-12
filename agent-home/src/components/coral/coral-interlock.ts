/*
 * Coordination between the two Coral surfaces: the launcher menu
 * (CoralHost) and the lead chat (LeadChatHost) shouldn't stack on each
 * other. Opening the menu parks the lead chat — closes it, remembering
 * that it was open — and closing the menu opens it back up.
 *
 * Both hosts own their `open` state; this module is only the handshake:
 * the chat reports its state, the launcher issues park/restore requests.
 */

let leadChatOpen = false;
let parkedByMenu = false;
const listeners = new Set<(open: boolean) => void>();

/** LeadChatHost reports its open state so the launcher knows whether to park it. */
export function reportLeadChatOpen(open: boolean): void {
  leadChatOpen = open;
}

/** Launcher: close the lead chat for the menu; true if it actually parked it. */
export function parkLeadChatForMenu(): boolean {
  if (!leadChatOpen) return false;
  parkedByMenu = true;
  for (const listener of listeners) listener(false);
  return true;
}

/** Launcher: reopen a lead chat that parkLeadChatForMenu closed. */
export function restoreLeadChatAfterMenu(): void {
  if (!parkedByMenu) return;
  parkedByMenu = false;
  for (const listener of listeners) listener(true);
}

/** LeadChatHost: receive open/close requests from the launcher. */
export function onLeadChatRequest(listener: (open: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const menuListeners = new Set<() => void>();

/**
 * Open the launcher menu from another control — the chat top bar on phones,
 * where the floating launcher is hidden so it can't cover the composer.
 */
export function requestCoralMenu(): void {
  for (const listener of menuListeners) listener();
}

/** CoralHost: receive open requests from {@link requestCoralMenu}. */
export function onCoralMenuRequest(listener: () => void): () => void {
  menuListeners.add(listener);
  return () => {
    menuListeners.delete(listener);
  };
}

/** Test-only reset — module state otherwise persists between tests. */
export function resetCoralInterlockForTests(): void {
  leadChatOpen = false;
  parkedByMenu = false;
  listeners.clear();
  menuListeners.clear();
}

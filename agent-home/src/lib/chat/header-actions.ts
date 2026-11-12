/**
 * Module-level mutable ref that bridges the server-component page boundary.
 *
 * The chat page (`app/chat/page.tsx`) is a server component — it renders
 * `MobileShell` whose header holds `ChatHeaderActions` (a client component),
 * while the actual `startNew` / `openArchived` callbacks live inside
 * `ChatPane` (also client, but rendered in the shell's `main`, below the
 * header).  The two are siblings, so props/context can't reach upward.
 *
 * `ChatPane` writes its latest callbacks into `chatHeaderActionsRef.current`
 * on every render (via `useEffect`); `ChatHeaderActions` reads them at click
 * time.  No context provider, no client wrapper, no store — just a stable ref
 * the two components share.
 *
 * Safe because: only one `ChatPane` instance exists at a time; the ref object
 * itself never changes identity; mutation doesn't trigger re-renders; and
 * `ChatPane` resets the callbacks to noops on unmount so a stale ref can't
 * fire after navigation away.
 */
export interface ChatHeaderActionsRef {
  startNew: () => void;
  openArchived: () => void;
  /** Opens the details sheet (rename, category, tags) of the open conversation. */
  openDetails: () => void;
  /** Opens the chats drawer (phones, where the sidebar is hidden). */
  openChats: () => void;
  /** Shows or hides the Filters & search panel. */
  toggleFilters: () => void;
  /** Copies the open conversation; resolves whether the clipboard took it. */
  copyChat: () => Promise<boolean>;
}

/** Callbacks that do nothing — the ref's value while no `ChatPane` is mounted. */
export function noopChatHeaderActions(): ChatHeaderActionsRef {
  const noop = () => {};
  return {
    startNew: noop,
    openArchived: noop,
    openDetails: noop,
    openChats: noop,
    toggleFilters: noop,
    copyChat: async () => false,
  };
}

export const chatHeaderActionsRef: { current: ChatHeaderActionsRef } = {
  current: noopChatHeaderActions(),
};

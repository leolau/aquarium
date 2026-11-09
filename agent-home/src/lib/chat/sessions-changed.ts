/**
 * Page-wide "the chat list changed" signal. A conversation hook fires it the
 * moment a turn is accepted (a brand-new chat exists from then on) and when a
 * turn finishes; every chats sidebar on the page listens and re-reads, so a
 * new chat shows under Recent at once instead of on the next poll.
 */
export const SESSIONS_CHANGED_EVENT = "aquarium:chat-sessions-changed";

export interface SessionsChangedDetail {
  profile?: string;
  /** The chat that just started or got a new message. */
  session?: { id: string; preview?: string | null };
}

export function notifySessionsChanged(detail: SessionsChangedDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SessionsChangedDetail>(SESSIONS_CHANGED_EVENT, { detail }));
}

export function onSessionsChanged(listener: (detail: SessionsChangedDetail) => void): () => void {
  const handle = (e: Event) => listener((e as CustomEvent<SessionsChangedDetail>).detail ?? {});
  window.addEventListener(SESSIONS_CHANGED_EVENT, handle);
  return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, handle);
}

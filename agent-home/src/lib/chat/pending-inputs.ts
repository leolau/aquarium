/**
 * Messages sent while the agent works (steer / queue / Stop & send) that have
 * not reached the model yet — the chips above the composer. Pure list
 * updates shared by the chat pane and the lead chat; every event is keyed by
 * the server's `item_id`, so a replayed or duplicated event is a no-op.
 */
import type { ChatInputMode, PendingChatInput } from "@/types";

export const INPUT_MODES: readonly ChatInputMode[] = ["steer", "queue", "interrupt"];

export function isInputMode(value: unknown): value is ChatInputMode {
  return typeof value === "string" && (INPUT_MODES as readonly string[]).includes(value);
}

/** Status a fresh item starts in: a steer waits for the next step, the rest wait in the queue. */
export function initialStatus(mode: ChatInputMode): PendingChatInput["status"] {
  return mode === "steer" ? "pending" : "queued";
}

/** Add an item, or refresh it in place if the server already told us about it. */
export function upsertPending(
  list: PendingChatInput[],
  item: PendingChatInput,
): PendingChatInput[] {
  const at = list.findIndex((p) => p.itemId === item.itemId);
  if (at === -1) return [...list, item];
  const cur = list[at];
  // A deferred or delivered steer keeps that status: a late echo of the
  // original accept must not flip it back to "after the current step".
  const sticky = cur.status === "deferred" || cur.status === "delivered";
  const merged = { ...cur, ...item, status: sticky ? cur.status : item.status };
  return list.map((p, i) => (i === at ? merged : p));
}

export function markDeferred(list: PendingChatInput[], itemId: string): PendingChatInput[] {
  return list.map((p) =>
    p.itemId === itemId && p.status !== "delivered" ? { ...p, status: "deferred" } : p,
  );
}

/** How long a steer chip says "Delivered" before it goes. */
export const DELIVERED_MS = 2000;

export function markDelivered(list: PendingChatInput[], itemId: string): PendingChatInput[] {
  return list.map((p) => (p.itemId === itemId ? { ...p, status: "delivered" } : p));
}

export function dropPending(list: PendingChatInput[], itemId: string): PendingChatInput[] {
  return list.some((p) => p.itemId === itemId) ? list.filter((p) => p.itemId !== itemId) : list;
}

/** `/api/chat/active`'s `pending`, read defensively (a reload's chips). */
export function pendingFromActive(raw: unknown): PendingChatInput[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingChatInput[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const { itemId, mode, text, status } = p as Record<string, unknown>;
    if (typeof itemId !== "string" || !itemId || typeof text !== "string" || !isInputMode(mode)) {
      continue;
    }
    out.push({
      itemId,
      mode,
      text,
      status: status === "deferred" || status === "pending" || status === "queued"
        ? status
        : initialStatus(mode),
    });
  }
  return out;
}

/**
 * The line shown when messages sent while the agent worked disappear without
 * reaching it (a Stop discarded them, or the server could not start them).
 */
export function notSentNotice(all: PendingChatInput[]): string | null {
  const items = all.filter((i) => i.status !== "delivered");
  if (items.length === 0) return null;
  const quoted = items
    .map((i) => `“${i.text.length > 60 ? `${i.text.slice(0, 59)}…` : i.text}”`)
    .join(", ");
  return `Not sent: ${quoted}. Send it again if you still want it.`;
}

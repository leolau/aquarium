/**
 * Attachments handed to the next chat composer that mounts — how Files →
 * Browse's "Ask the agent about this file" lands in a chat with the file
 * already attached. Held in `sessionStorage` for one page hop, then cleared.
 */
import type { ChatAttachment } from "@/types";

const KEY = "agent-home:pending-attachments";

function isAttachment(value: unknown): value is ChatAttachment {
  const a = value as ChatAttachment;
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.path === "string" &&
    typeof a.name === "string" &&
    typeof a.content_type === "string" &&
    typeof a.size === "number"
  );
}

export function setPendingAttachments(attachments: ChatAttachment[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(attachments));
  } catch {
    // Private mode / storage full: the chat opens without the file.
  }
}

/** Read and clear: each pending attachment reaches one composer only. */
export function takePendingAttachments(): ChatAttachment[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    sessionStorage.removeItem(KEY);
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAttachment) : [];
  } catch {
    return [];
  }
}

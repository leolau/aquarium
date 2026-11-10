/**
 * Pure helpers for the in-flight chat turn's message list.
 *
 * The streaming turn appends a placeholder assistant message and then rewrites
 * its content on every `assistant.delta` / `assistant.completed` event. The
 * update MUST NOT rely on object identity: the first delta replaces the
 * placeholder with a new object, so an identity match (`m === live`) silently
 * stops matching after the first delta and the reply is truncated to its first
 * token. Targeting the trailing assistant message by position is stable across
 * those replacements. This is the regression fix for "only shows the first
 * couple of characters then stopped".
 */
import type { ChatMessage } from "@/types";

/**
 * Return a new list with the content of the trailing assistant message set to
 * `content`. If the last message is not an assistant turn (nothing streaming),
 * the list is returned unchanged.
 */
export function setLastAssistantContent(
  messages: ChatMessage[],
  content: string,
): ChatMessage[] {
  if (messages.length === 0) return messages;
  const idx = messages.length - 1;
  const last = messages[idx];
  if (last.role !== "assistant") return messages;
  if (last.content === content) return messages;
  const next = messages.slice();
  next[idx] = { ...last, content };
  return next;
}

/**
 * An in-flight turn that belongs to a session other than the one currently on
 * screen. Buffering it (rather than blocking the switch) lets the user move
 * between conversations at any time while a turn keeps streaming in the
 * background; when they return, the buffered turn is overlaid onto that
 * session's persisted transcript.
 */
export interface LiveTurn {
  user: string;
  assistant: string;
  /** Steers the agent has read during this turn ("Sent while working"). */
  steered?: string[];
}

/**
 * Show a steer the agent just read as the user's own bubble. It lands above
 * the reply still streaming (the agent changes course from here on), or at
 * the end when no reply bubble is open.
 */
export function insertSteeredBubble(messages: ChatMessage[], text: string): ChatMessage[] {
  const bubble: ChatMessage = { role: "user", content: text, sentWhileWorking: true };
  const last = messages[messages.length - 1];
  return last && last.role === "assistant"
    ? [...messages.slice(0, -1), bubble, last]
    : [...messages, bubble];
}

/**
 * Overlay a still-streaming turn onto a session's loaded transcript: the just
 * -sent user message and the assistant text accumulated so far. The persisted
 * transcript does not yet contain this turn (it is written on completion), so
 * appending here is what makes a returned-to session show its live progress.
 */
export function withLiveTurn(
  base: ChatMessage[],
  live: LiveTurn | undefined,
): ChatMessage[] {
  if (!live) return base;
  return [
    ...base,
    { role: "user", content: live.user },
    ...(live.steered ?? []).map(
      (content): ChatMessage => ({ role: "user", content, sentWhileWorking: true }),
    ),
    { role: "assistant", content: live.assistant },
  ];
}

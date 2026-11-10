/**
 * Display-side sanitization of persisted one-brain transcripts.
 *
 * The Python session store returns every row verbatim, including internal
 * scaffolding that must never render as a chat bubble: context-compaction
 * summaries and the machine-injected `[app context: …]` line prepended to
 * user turns by `ui-context.ts`. Stripping happens ONLY at render time —
 * search and the model's own history keep the raw rows.
 *
 * Keep the markers below in sync with `agent/context_compressor.py`:
 * `SUMMARY_PREFIX` (~L44), `LEGACY_SUMMARY_PREFIX` (~L71),
 * `_SUMMARY_END_MARKER` (~L93) and `_MERGED_PRIOR_CONTEXT_HEADER` /
 * `_MERGED_SUMMARY_DELIMITER` (~L103), and the steer markers with
 * `STEER_MARKER_OPEN` / `STEER_MARKER_CLOSE` in `agent/prompt_builder.py`.
 */
import type { ChatMessage } from "@/types";

export const COMPACTION_PREFIXES = [
  "[CONTEXT COMPACTION — REFERENCE ONLY]",
  "[CONTEXT COMPACTION - REFERENCE ONLY]",
  "[CONTEXT SUMMARY]:",
] as const;

export const COMPACTION_END_MARKER =
  "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";

/** Prepended to a tail message when the summary is merged into it. */
export const MERGED_PRIOR_CONTEXT_HEADER =
  "[PRIOR CONTEXT — for reference only; not a new message]";

/** Separates the preserved original content from the merged summary. */
export const MERGED_SUMMARY_DELIMITER =
  "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]";

export interface CompactionSplit {
  /** The user-visible remainder ("" when the row is summary-only). */
  display: string;
  /** True when the row contained compaction material. */
  hadCompaction: boolean;
}

/**
 * Split a persisted message into what may be shown to the user.
 *
 * Three shapes exist:
 * 1. Standalone summary — `<prefix>…<body>\n\n<END marker>` → display "".
 * 2. Legacy merge — `<prefix>…<body>\n\n<END marker>\n<original reply>` →
 *    display = the original reply after the marker.
 * 3. Current merge — `<HEADER>\n<original content>\n\n<DELIMITER>\n\n<summary>
 *    \n\n<END marker>` → display = the original content between header and
 *    delimiter.
 */
export function splitCompactionContent(content: string): CompactionSplit {
  const head = content.trimStart();

  if (head.startsWith(MERGED_PRIOR_CONTEXT_HEADER)) {
    const headerIdx = content.indexOf(MERGED_PRIOR_CONTEXT_HEADER);
    const delimIdx = content.indexOf(MERGED_SUMMARY_DELIMITER);
    if (delimIdx < 0) return { display: "", hadCompaction: true };
    const display = content
      .slice(headerIdx + MERGED_PRIOR_CONTEXT_HEADER.length, delimIdx)
      .trim();
    return { display, hadCompaction: true };
  }

  if (COMPACTION_PREFIXES.some((p) => head.startsWith(p))) {
    const markerIdx = content.indexOf(COMPACTION_END_MARKER);
    if (markerIdx < 0) return { display: "", hadCompaction: true };
    const display = content
      .slice(markerIdx + COMPACTION_END_MARKER.length)
      .replace(/^\s+/, "");
    return { display, hadCompaction: true };
  }

  return { display: content, hadCompaction: false };
}

/** Remove the single `[app context: …]` line `withUiContext()` prepends. */
export function stripUiContextLine(content: string): string {
  return content.replace(/^\[app context:[^\n]*\][ \t]*\r?\n?/, "");
}

/**
 * Notes `_materialize_agent_home_attachments` (hermes_cli/web_server.py)
 * prepends to a user turn, one per attachment: the document/image notes from
 * `gateway/run.py::_build_document_context_note` (a text file's content
 * follows as `--- <name> ---\n<text>`) and the could-not-be-read notes.
 */
const ATTACHMENT_NOTE = /^\[The user (?:sent (?:a text document|a document|an image): '|attached ')/;
const NOTE_START = /\n\n\[The user (?:sent (?:a text document|a document|an image): '|attached ')/;
const LINK_LINE = /^!?\[[^\]\n]*\]\([^)\s]+\)$/;

/** Where the trailing block of attachment links (`withAttachments`) starts. */
function trailingLinksStart(text: string): number {
  const lines = text.split("\n");
  let i = lines.length;
  while (i > 0 && LINK_LINE.test(lines[i - 1])) i--;
  return i === lines.length ? text.length : lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
}

/** Remove the attachment notes the backend prepends to a user turn. */
export function stripAttachmentNotes(content: string): string {
  if (!ATTACHMENT_NOTE.test(content)) return content;
  // The user's own message starts at the context line, when there is one.
  const ctx = content.indexOf("\n\n[app context:");
  if (ctx >= 0) return content.slice(ctx + 2);
  let rest = content;
  while (ATTACHMENT_NOTE.test(rest)) {
    const close = rest.indexOf("]\n\n");
    if (close < 0) return "";
    rest = rest.slice(close + 3);
    if (!rest.startsWith("--- ")) continue;
    // Inlined file text runs to the next note. After the last one nothing
    // marks where the file ends and the user's text starts (that is what the
    // context line is for), so show only the attachment links: never the file.
    const next = rest.search(NOTE_START);
    if (next >= 0) {
      rest = rest.slice(next + 2);
      continue;
    }
    return rest.slice(trailingLinksStart(rest));
  }
  return rest;
}

/** What the user typed: without the attachment notes and app-context line. */
export function stripInjectedContext(content: string): string {
  return stripUiContextLine(stripAttachmentNotes(content));
}

/**
 * The `[Referenced items]` block the brain appends to a turn that names short
 * refs (FG-36, `hermes_cli/ref_mentions.py`): context for the agent, not what
 * the sender typed, so their bubble hides it. Only a trailing block counts.
 */
export function stripRefMentions(content: string): string {
  return content.replace(/\n\n\[Referenced items\]\n(?:- [^\n]*(?:\n|$))+$/, "");
}

/**
 * A mid-turn steer is delivered by appending
 * `\n\n<OPEN>\n<text>\n<CLOSE>` to the last tool result of a step (see
 * `format_steer_marker`), so after a reload it only exists inside a tool row.
 */
export const STEER_MARKER_OPEN =
  "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered mid-turn; not tool output]";
export const STEER_MARKER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]";

export interface SteerSplit {
  /** The tool output with the steer blocks removed. */
  output: string;
  /** The steer texts, oldest first. */
  steers: string[];
}

/**
 * Split the trailing steer blocks off a tool result. Only blocks at the very
 * end count — that is the only place the agent appends them — so a lookalike
 * marker in the middle of tool, web or file output stays tool output.
 */
export function splitSteerBlocks(content: string): SteerSplit {
  const steers: string[] = [];
  let rest = content;
  for (;;) {
    const tail = rest.replace(/\s+$/, "");
    if (!tail.endsWith(STEER_MARKER_CLOSE)) break;
    const body = tail.slice(0, -STEER_MARKER_CLOSE.length);
    const openAt = body.lastIndexOf(STEER_MARKER_OPEN);
    if (openAt < 0 || (openAt > 0 && body[openAt - 1] !== "\n")) break;
    const text = body.slice(openAt + STEER_MARKER_OPEN.length).trim();
    if (text) steers.unshift(text);
    rest = body.slice(0, openAt).replace(/\s+$/, "");
  }
  return steers.length === 0 ? { output: content, steers } : { output: rest, steers };
}

/** Flatten tool content: a string, or Anthropic-style content blocks. */
function toolContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((t) => t !== "")
    .join("\n\n");
}

/**
 * Rows a user-facing transcript renders (mirrors ChatPane's filter): user and
 * assistant turns, plus each steer delivered inside a tool result as the
 * user's own row (`sentWhileWorking`), placed where that tool step ran. It
 * reuses the tool row's id so keys and paging cursors stay unique.
 */
export function visibleTurns(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user" || m.role === "assistant") {
      out.push(m);
      continue;
    }
    if (m.role !== "tool") continue;
    const { steers } = splitSteerBlocks(toolContentText(m.content));
    if (steers.length === 0) continue;
    const row: ChatMessage = {
      role: "user",
      content: steers.join("\n\n"),
      sentWhileWorking: true,
    };
    if (m.id != null) row.id = m.id;
    if (m.timestamp != null) row.timestamp = m.timestamp;
    out.push(row);
  }
  return out;
}

/** True when two persisted rows would render identically. */
function sameRow(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.content === b.content &&
    (a.reasoning ?? null) === (b.reasoning ?? null) &&
    (a.timestamp ?? null) === (b.timestamp ?? null)
  );
}

function sameList(a: ChatMessage[], b: ChatMessage[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

/**
 * Prepend an older page (`before=<oldest id>`) to a loaded thread. Rows not
 * strictly older than the thread's oldest persisted row are skipped, so an
 * overlapping or replayed page never duplicates a turn.
 */
export function mergeOlderPage(
  current: ChatMessage[],
  older: ChatMessage[],
): ChatMessage[] {
  const oldest = current.find((m) => m.id != null)?.id;
  const add =
    oldest == null ? older : older.filter((m) => m.id != null && m.id < oldest);
  return add.length === 0 ? current : [...add, ...current];
}

export interface TailReconcile {
  messages: ChatMessage[];
  /** Rows older than the page were kept, so the thread's own `hasMore` still applies. */
  keptOlder: boolean;
}

/**
 * Reconcile a loaded thread with the newest page from the server: the page
 * replaces the tail; already-loaded older rows (ids below the page's first
 * id) are kept only when the page overlaps them — otherwise there may be a
 * gap and the page alone is the truth. Optimistic rows (no id) are dropped
 * unless `keep` says they are still pending; a kept optimistic user row the
 * page already ends with (persisted at turn start) is dropped as a duplicate,
 * as is a kept row the page now holds as a new persisted row (an assistant
 * row once any new assistant row lands; a user row by its text).
 * Unchanged rows keep their object identity, and an unchanged thread returns
 * `current` itself.
 */
export function reconcileTail(
  current: ChatMessage[],
  page: ChatMessage[],
  opts: { pageHasMore: boolean; keep?: (m: ChatMessage) => boolean },
): TailReconcile {
  const byId = new Map<number, ChatMessage>();
  let maxId = -Infinity;
  for (const m of current) {
    if (m.id == null) continue;
    byId.set(m.id, m);
    if (m.id > maxId) maxId = m.id;
  }
  const tail = page.map((m) => {
    const prev = m.id != null ? byId.get(m.id) : undefined;
    return prev && sameRow(prev, m) ? prev : m;
  });
  const firstId = page.find((m) => m.id != null)?.id;
  const older =
    opts.pageHasMore && firstId != null && maxId >= firstId
      ? current.filter((m) => m.id != null && m.id < firstId)
      : [];
  const keep = opts.keep;
  const fresh = page.filter((m) => m.id != null && m.id > maxId);
  const persisted = (p: ChatMessage) =>
    p.role === "assistant"
      ? fresh.some((f) => f.role === "assistant")
      : fresh.some(
          (f) => f.role === p.role && stripInjectedContext(f.content).trim() === p.content.trim(),
        );
  const pending = keep
    ? current.filter((m) => m.id == null && keep(m) && !persisted(m))
    : [];
  const last = page[page.length - 1];
  if (
    pending[0]?.role === "user" &&
    last?.role === "user" &&
    last.id != null &&
    stripInjectedContext(last.content).trim() === pending[0].content.trim()
  ) {
    pending.shift();
  }
  const next = [...older, ...tail, ...pending];
  return {
    messages: sameList(next, current) ? current : next,
    keptOlder: older.length > 0,
  };
}

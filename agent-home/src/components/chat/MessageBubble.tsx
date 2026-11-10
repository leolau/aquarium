"use client";

import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { ChatFile } from "@/components/chat/ChatFile";
import { ChatMedia } from "@/components/chat/ChatMedia";
import { RichText } from "@/components/chat/RichText";
import { mediaRefPath } from "@/lib/chat/media-ref";
import { splitCompactionContent, stripInjectedContext } from "@/lib/chat/transcript";
import type { ChatMessage } from "@/types";

interface Segment {
  kind: "text" | "image" | "file";
  value: string;
  alt?: string;
}

/**
 * Split content into text, inline `![alt](url)` image segments, and
 * `[name](ref)` file-attachment links that point at a private-bucket media ref
 * (other links stay literal text — user turns aren't full Markdown).
 */
function segment(content: string): Segment[] {
  const out: Segment[] = [];
  const re = /(!?)\[([^\]]*)\]\((\S+?)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const isImage = m[1] === "!";
    const isFileRef = !isImage && mediaRefPath(m[3]) !== null;
    if (!isImage && !isFileRef) continue; // leave plain links as text
    if (m.index > last) {
      out.push({ kind: "text", value: content.slice(last, m.index) });
    }
    out.push({ kind: isImage ? "image" : "file", value: m[3], alt: m[2] });
    last = re.lastIndex;
  }
  if (last < content.length) {
    out.push({ kind: "text", value: content.slice(last) });
  }
  return out;
}

/**
 * A user turn: literal text plus any inline media they sent — images preview
 * via `![alt](ref)`, other files (PDF/DOC/XLS/…) render as `[name](ref)`
 * download chips.
 */
function UserContent({ content, highlightTerm }: { content: string; highlightTerm?: string }) {
  return (
    <>
      {segment(content).map((s, i) => {
        if (s.kind === "text") return <span key={i}>{highlightText(s.value, highlightTerm ?? "")}</span>;
        if (s.kind === "file") {
          const filePath = mediaRefPath(s.value);
          return filePath ? (
            <ChatFile key={i} path={filePath} name={s.alt || "attachment"} />
          ) : (
            <span key={i}>{s.alt || s.value}</span>
          );
        }
        const path = mediaRefPath(s.value);
        return path ? (
          <ChatMedia key={i} path={path} alt={s.alt || "attachment"} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={s.value}
            alt={s.alt || "attachment"}
            className="mt-1 max-h-64 rounded-lg"
          />
        );
      })}
    </>
  );
}

/**
 * One chat turn rendered as a mobile bubble — user turns align right, the
 * agent's align left. The agent's reply is rendered as sanitized Markdown/HTML
 * (tables, lists, headings, code, links, inline media). User turns stay literal
 * text (their input is never interpreted as markup) plus any media they sent.
 */
/** Highlight *term* inside *text*, returning React nodes. */
function highlightText(text: string, term: string): ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark
        key={key++}
        className="rounded bg-[var(--color-warn)] px-0.5 text-[var(--color-bg)]"
      >
        {text.slice(idx, idx + term.length)}
      </mark>,
    );
    i = idx + term.length;
  }
  return parts.length > 1 ? parts : text;
}

/** Off-screen history rows skip layout/paint; the estimate keeps the scrollbar sane. */
const ROW_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 120px",
};

/** Copies the reply's text; visible on hover/focus (always, subtly, on touch). */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      data-component="CopyReply"
      aria-label="Copy reply"
      onClick={copy}
      className="shrink-0 self-end rounded-md px-1.5 py-0.5 text-xs text-[var(--color-muted)] opacity-0 transition-opacity hover:text-[var(--color-fg)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-60"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CompactionDivider() {
  return (
    <div data-component="CompactionDivider" className="flex justify-center">
      <span className="text-xs italic text-[var(--color-muted)]">
        Context compacted
      </span>
    </div>
  );
}

/**
 * Memoized so a streaming turn — which re-renders `ChatPane` on every delta
 * and once a second while a turn is in flight — only re-parses Markdown and
 * re-runs the media-segment regex for the bubble whose `message` object
 * actually changed. `setLastAssistantContent` (lib/chat/messages.ts)
 * preserves identity for every other message, so this is a real skip, not
 * just a re-render with the same output: without it, a long conversation
 * re-parses every bubble's Markdown on every token.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  msgIndex,
  highlightTerm,
}: {
  message: ChatMessage;
  msgIndex?: number;
  highlightTerm?: string;
}) {
  const isUser = message.role === "user";
  const split = splitCompactionContent(message.content ?? "");
  const content = isUser ? stripInjectedContext(split.display) : split.display;
  const reasoning = isUser ? "" : (message.reasoning ?? "").trim();

  if (content === "" && reasoning === "") {
    // Summary-only row (or a user turn that was just the context line): no
    // bubble at all — at most the compaction divider.
    return split.hadCompaction ? <CompactionDivider /> : null;
  }

  return (
    <>
      {split.hadCompaction ? <CompactionDivider /> : null}
      <div
        data-component="MessageBubble"
        data-msg-index={msgIndex}
        data-role={message.role}
        data-sent-while-working={isUser && message.sentWhileWorking ? "true" : undefined}
        style={ROW_STYLE}
        className={`group flex gap-1 ${isUser ? "justify-end" : "justify-start"}`}
      >
        <div
          className={`max-w-[85%] break-words rounded-2xl px-3 py-2 text-sm ${
            isUser
              ? "whitespace-pre-wrap bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
              : "bg-[var(--color-surface-2)] text-[var(--color-fg)]"
          }`}
        >
          {isUser ? (
            <>
              {message.sentWhileWorking ? (
                <div className="mb-0.5 text-[11px] font-medium opacity-80">Sent while working</div>
              ) : null}
              <UserContent content={content} highlightTerm={highlightTerm} />
            </>
          ) : (
            <>
              {reasoning !== "" ? (
                <details className="mb-2 text-xs text-[var(--color-muted)]">
                  <summary className="cursor-pointer select-none">Reasoning</summary>
                  <div className="mt-1 whitespace-pre-wrap">{reasoning}</div>
                </details>
              ) : null}
              <RichText content={content} />
            </>
          )}
        </div>
        {!isUser && content !== "" ? <CopyButton text={content} /> : null}
      </div>
    </>
  );
});

"use client";

import { useRef, type RefObject } from "react";

/** A monospace textarea with a line-number gutter that scrolls with it. */
export function CodeEditor({
  value,
  onChange,
  label,
  textareaRef,
  className = "",
}: {
  value: string;
  onChange(next: string): void;
  label: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = Math.max(1, value.split("\n").length);
  return (
    <div data-component="CodeEditor" className={`flex min-h-0 flex-1 font-mono text-[12.5px] leading-[1.65] ${className}`}>
      <div
        ref={gutter}
        aria-hidden
        className="select-none overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 pb-6 pt-2.5 text-right text-[var(--color-muted)]"
      >
        {Array.from({ length: lines }, (_, k) => (
          <div key={k}>{k + 1}</div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        aria-label={label}
        spellCheck={false}
        wrap="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        className="min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent px-3 pt-2.5 pb-6 text-[var(--color-fg)] outline-none [tab-size:2]"
      />
    </div>
  );
}

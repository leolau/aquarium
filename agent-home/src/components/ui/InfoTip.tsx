"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { InfoIcon } from "@/components/ui/icons";

/**
 * Figma `info-tip` (15:242): a tap-to-open explanation. Works on touch (no
 * hover-only `title`), closes on Escape, an outside tap or a second tap.
 */
export function InfoTip({
  label,
  children,
  align = "start",
}: {
  /** Accessible name of the trigger, e.g. "What is a profile?". */
  label: string;
  children: ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Keep the note inside the viewport when the trigger sits near an edge
  // (a long page title on a phone pushes it right).
  useLayoutEffect(() => {
    const el = note.current;
    if (!open || !el) return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    let dx = r.right > vw - 8 ? vw - 8 - r.right : 0;
    if (r.left + dx < 8) dx = 8 - r.left;
    if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span ref={root} data-component="InfoTip" className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-full)] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
      >
        <InfoIcon size={16} />
      </button>
      {open ? (
        <span
          ref={note}
          id={id}
          role="note"
          className={`absolute top-full z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[13px] font-normal leading-5 text-[var(--color-fg)] shadow-lg [overflow-wrap:anywhere] ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

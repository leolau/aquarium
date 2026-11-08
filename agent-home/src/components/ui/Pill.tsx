import type { ReactNode } from "react";

/** Shared badge tones (mirrors the GTS Centre palette). */
export type Tone = "accent" | "success" | "warning" | "danger" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  accent: "bg-[var(--color-accent)] text-[var(--color-accent-fg)]",
  success: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  warning: "bg-[var(--color-warn)]/15 text-[var(--color-warn-text)]",
  danger: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  muted: "bg-[var(--color-surface-2)] text-[var(--color-fg)]",
};

/** A small rounded status pill used across the mobile feature panels. */
export function Pill({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      data-component="Pill"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

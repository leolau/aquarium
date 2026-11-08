import type { NeedsYouSeverity } from "@/types/landing";

/** Severity → colours, all from the `--color-*` tokens in globals.css. */
export const SEVERITY_TONE: Record<
  NeedsYouSeverity,
  { card: string; icon: string; button: string; label: string }
> = {
  blocking: {
    card: "border-[var(--color-danger)] bg-[var(--color-danger)]/10",
    icon: "text-[var(--color-danger)]",
    button: "bg-[var(--color-danger)] text-[var(--color-bg)] hover:brightness-110",
    label: "Blocking",
  },
  approval: {
    card: "border-[var(--color-warn)] bg-[var(--color-attention-bg)]",
    icon: "text-[var(--color-warn)]",
    button: "bg-[var(--color-warn)] text-[var(--color-bg)] hover:brightness-110",
    label: "Needs approval",
  },
  review: {
    card: "border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10",
    icon: "text-[var(--color-accent)]",
    button: "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:brightness-110",
    label: "To review",
  },
  fyi: {
    card: "border-[var(--color-border)] bg-[var(--color-surface-2)]",
    icon: "text-[var(--color-muted)]",
    button:
      "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]",
    label: "For your information",
  },
};

export const SEVERITY_RANK: Record<NeedsYouSeverity, number> = {
  blocking: 0,
  approval: 1,
  review: 2,
  fyi: 3,
};

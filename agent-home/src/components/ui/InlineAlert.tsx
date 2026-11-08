import type { ReactNode } from "react";

import { AlertIcon, CheckIcon, InfoIcon } from "@/components/ui/icons";

export type AlertTone = "info" | "success" | "warn" | "danger";

const TONE: Record<AlertTone, { box: string; icon: string }> = {
  info: { box: "border-[var(--color-border)] bg-[var(--color-surface)]", icon: "text-[var(--color-accent)]" },
  success: { box: "border-[var(--color-success)]/40 bg-[var(--color-surface)]", icon: "text-[var(--color-success)]" },
  warn: { box: "border-[var(--color-warn)]/40 bg-[var(--color-attention-bg)]", icon: "text-[var(--color-warn-text)]" },
  danger: { box: "border-[var(--color-danger)]/40 bg-[var(--color-surface)]", icon: "text-[var(--color-danger)]" },
};

/**
 * Figma `inline-alert` (15:266): token-only Info / Success / Warn / Danger
 * message. Danger is announced (`role="alert"`); the rest are `status`.
 */
export function InlineAlert({
  tone = "info",
  title,
  children,
  action,
  className = "",
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const t = TONE[tone];
  const Icon = tone === "success" ? CheckIcon : tone === "info" ? InfoIcon : AlertIcon;
  return (
    <div
      data-component="InlineAlert"
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-[var(--radius-lg)] border p-3 text-sm ${t.box} ${className}`}
    >
      <Icon size={18} className={`mt-0.5 ${t.icon}`} />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {title ? <p className="font-medium text-[var(--color-fg)]">{title}</p> : null}
        {children ? <div className="text-[var(--color-muted)]">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

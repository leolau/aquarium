"use client";

import { useT } from "@/i18n/client";

import type { HealthState } from "./toolsModel";

/**
 * Health is never colour alone: each state has its own fill/pattern and a
 * text label for screen readers and the tooltip.
 */
const STYLE: Record<HealthState, string> = {
  running: "bg-[#2f8f4e] border-[#2f8f4e]",
  building: "bg-[#d69e2e] border-[#d69e2e]",
  down: "bg-[#c53b3b] border-[#c53b3b]",
  off: "bg-[#9aa0a6] border-[#9aa0a6]",
  dev: "border-[#2f8f4e] bg-[repeating-linear-gradient(45deg,#2f8f4e_0_2px,transparent_2px_4px)]",
  unknown: "bg-transparent border-[#9aa0a6]",
};

export function HealthDot({ state, className = "" }: { state: HealthState; className?: string }) {
  const t = useT("tools");
  const label = t(`health.${state}`);
  return (
    <span
      data-component="HealthDot"
      data-health={state}
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block h-3 w-3 rounded-full border-2 ring-2 ring-[var(--color-surface)] ${STYLE[state]} ${className}`}
    />
  );
}

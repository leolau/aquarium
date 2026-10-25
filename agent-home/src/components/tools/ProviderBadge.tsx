"use client";

import { useT } from "@/i18n/client";

import type { ProviderId } from "./toolsModel";

/**
 * The small corner badge on an app icon: a box for "On this box", or the
 * provider's bundled monochrome mark (never hotlinked) for hosted apps.
 */
export function ProviderBadge({
  provider,
  className = "",
}: {
  provider: ProviderId | "box";
  className?: string;
}) {
  const t = useT("tools");
  const label = t(`provider.${provider}`);
  return (
    <span
      data-component="ProviderBadge"
      data-provider={provider}
      title={label}
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny bundled SVG */}
      <img src={`/providers/${provider}.svg`} alt={label} width={12} height={12} className="h-3 w-3" />
    </span>
  );
}

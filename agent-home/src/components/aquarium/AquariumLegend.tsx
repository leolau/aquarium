"use client";

import { useT } from "@/i18n/client";

/** Compact key to what size, speed and the little followers mean. */
export function AquariumLegend() {
  const t = useT("aquarium");
  const rows = ["size", "speed", "followers", "active", "self"] as const;
  return (
    <details
      data-component="AquariumLegend"
      open
      className="group max-w-64 rounded-2xl bg-[rgb(3_24_52/0.62)] px-3 py-2 text-xs text-white/90 shadow-lg backdrop-blur-sm"
    >
      <summary className="cursor-pointer select-none font-semibold text-white">{t("legend.title")}</summary>
      <ul className="mt-1.5 space-y-1">
        {rows.map((key) => (
          <li key={key} className="flex gap-2">
            <span aria-hidden className="shrink-0">
              {t(`legend.${key}Icon`)}
            </span>
            <span>{t(`legend.${key}`)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

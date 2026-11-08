"use client";

import { AquariumLoader } from "@/components/brand/AquariumLoader";
import { useT } from "@/i18n/client";

/**
 * The route-level loading screen (Figma "Loading"): the animated Aquarium
 * loader centred with one line of copy. No page header and no launcher of its
 * own — the surrounding shell decides those.
 */
export function RouteLoading({ label }: { label?: string }) {
  const t = useT("auth");
  const text = label ?? t("opening");
  return (
    <div
      data-component="RouteLoading"
      aria-busy="true"
      className="flex min-h-[50dvh] w-full flex-col items-center justify-center gap-4 py-12 text-center"
    >
      <AquariumLoader size={64} label={text} />
      <p className="text-sm text-[var(--color-muted)]">{text}</p>
    </div>
  );
}

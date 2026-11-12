"use client";

import { requestCoralMenu } from "@/components/coral/coral-interlock";
import { useT } from "@/i18n";

/**
 * The Coral launcher's stand-in in the phone chat top bar, where the floating
 * button is hidden so it can't sit over the composer. Opens the same menu.
 */
export function CoralMenuButton() {
  const t = useT("nav");
  return (
    <button
      type="button"
      data-component="CoralMenuButton"
      data-action="open-coral"
      onClick={requestCoralMenu}
      aria-label={t("openMenu")}
      title={t("openMenu")}
      className="-mx-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
    >
      <span
        aria-hidden
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm text-[var(--color-accent-fg)]"
        style={{
          background:
            "linear-gradient(135deg, var(--color-accent), color-mix(in srgb, var(--color-accent) 60%, #ff7e6b))",
        }}
      >
        ❋
      </span>
    </button>
  );
}

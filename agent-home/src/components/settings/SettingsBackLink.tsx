"use client";

import Link from "next/link";

import { useT } from "@/i18n";

/** "← All settings", above each Settings detail page. */
export function SettingsBackLink() {
  const t = useT("settings");
  return (
    <Link
      href="/settings"
      data-component="SettingsBackLink"
      className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-accent)]"
    >
      <span aria-hidden>←</span>
      {t("back")}
    </Link>
  );
}

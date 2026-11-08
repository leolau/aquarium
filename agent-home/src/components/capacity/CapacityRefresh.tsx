"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { LoaderIcon, RefreshIcon } from "@/components/ui/icons";
import { useT } from "@/i18n/client";

/** Re-reads the indicators; the old reading stays on screen until the new one lands. */
export function CapacityRefresh() {
  const t = useT("settings");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      data-action="capacity-refresh"
      disabled={pending}
      aria-busy={pending}
      onClick={() => start(() => router.refresh())}
      className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-semibold disabled:opacity-60"
    >
      {pending ? (
        <LoaderIcon size={16} aria-hidden className="animate-spin" />
      ) : (
        <RefreshIcon size={16} aria-hidden />
      )}
      {pending ? t("capacity.refreshing") : t("capacity.refresh")}
    </button>
  );
}

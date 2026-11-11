"use client";

import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n";

/** "2 cards scheduled": cards on the project's board parked until a time. */
export function ScheduledCardsBadge({ count }: { count?: number | null }) {
  const t = useT("projects");
  if (!count || count <= 0) return null;
  return (
    <span data-component="ScheduledCardsBadge">
      <Pill tone="muted">
        {count === 1 ? t("scheduledCardsOne") : t("scheduledCardsMany", { count })}
      </Pill>
    </span>
  );
}

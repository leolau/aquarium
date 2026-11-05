"use client";

import { useCallback } from "react";

import { agoLabel, dateTimeLabel, dayDistance, isoDayLabel } from "@/components/projects/format";
import { formatWhen } from "@/components/projects/scope/clarify";
import { useHydrated } from "@/lib/use-hydrated";

export type TimeLabelKind = "dateTime" | "ago" | "day" | "date";

const FORMAT: Record<TimeLabelKind, (epochSeconds: number) => string> = {
  dateTime: dateTimeLabel,
  ago: agoLabel,
  day: dayDistance,
  date: (s) => formatWhen(s) ?? "—",
};

/**
 * Time labels that depend on the browser's clock, locale or zone ("21d ago",
 * "12 Aug, 14:05"). The server and the first client render show the UTC day
 * instead, so hydration never sees a text mismatch (React #418); the real
 * label replaces it straight after hydration.
 */
export function useTimeLabel(): (epochSeconds: number | null | undefined, kind?: TimeLabelKind) => string {
  const hydrated = useHydrated();
  return useCallback(
    (epochSeconds, kind = "dateTime") => {
      if (epochSeconds == null) return kind === "ago" ? "never" : "—";
      return hydrated ? FORMAT[kind](epochSeconds) : isoDayLabel(epochSeconds);
    },
    [hydrated],
  );
}

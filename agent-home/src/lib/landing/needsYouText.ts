"use client";

import { useMemo } from "react";

import { useT } from "@/i18n";
import type { NeedsYouEntry, NeedsYouSeverity, NeedsYouTextPart } from "@/types/landing";

/** Needs-you text in the reader's language; server English is the fallback. */
export function useNeedsYouText() {
  const t = useT("needsYou");
  return useMemo(() => {
    const parts = (list: NeedsYouTextPart[] | undefined): string | null => {
      if (!list?.length || !list.every((p) => t.has(p.key))) return null;
      return list.map((p) => t(p.key, p.vars)).join(" · ");
    };
    return {
      t,
      title: (e: NeedsYouEntry) => parts(e.i18n?.title) ?? e.title,
      detail: (e: NeedsYouEntry) => parts(e.i18n?.detail) ?? e.detail ?? null,
      action: (label: string) => {
        const base = label.replace(/(…|\.\.\.)$/, "");
        if (!t.has(`actions.${base}`)) return label;
        return t(`actions.${base}`) + label.slice(base.length);
      },
      severity: (s: NeedsYouSeverity) => t(`severity.${s}`),
      /** "just now", "8 min", "1 h", "3 d" — how long an item has been waiting. */
      age: (createdAtSec: number, nowMs: number) => {
        const s = Math.max(0, Math.floor(nowMs / 1000 - createdAtSec));
        if (s < 60) return t("age.justNow");
        const m = Math.floor(s / 60);
        if (m < 60) return t("age.min", { n: m });
        const h = Math.floor(m / 60);
        if (h < 24) return t("age.h", { n: h });
        return t("age.d", { n: Math.floor(h / 24) });
      },
    };
  }, [t]);
}

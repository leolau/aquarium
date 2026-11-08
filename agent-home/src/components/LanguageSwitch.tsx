"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { htmlLang, LOCALE_LABELS, LOCALES, useLocale, useT, type Locale } from "@/i18n";
import { useAction } from "@/lib/use-action";

/**
 * EN / 繁體中文 switch. Before sign-in it remembers the choice in this browser;
 * when signed in it is also saved for the person. The page re-renders in the
 * new language straight away.
 */
export function LanguageSwitch({ showNote = false }: { showNote?: boolean }) {
  const t = useT("common");
  const locale = useLocale();
  const router = useRouter();
  const [target, setTarget] = useState<Locale | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, startRefresh] = useTransition();

  // One lock for both buttons: a quick EN-then-中文 tap must not post twice,
  // and the switch stays busy until the re-rendered page has landed.
  const save = useAction(async (next: Locale) => {
    setTarget(next);
    setFailed(false);
    try {
      const res = await fetch("/api/session/language", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!res.ok) setFailed(true);
      startRefresh(() => router.refresh());
    } catch {
      setFailed(true);
    }
  });
  const working = save.pending || refreshing;
  const busy = working ? target : null;

  function choose(next: Locale) {
    if (working || next === locale) return;
    void save.run(next);
  }

  return (
    <div data-component="LanguageSwitch" className="flex flex-col gap-1">
      <div
        role="group"
        aria-label={t("language")}
        aria-busy={working}
        className="inline-flex w-fit rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5"
      >
        {LOCALES.map((code) => {
          const active = code === locale;
          return (
            <button
              type="button"
              key={code}
              lang={htmlLang(code)}
              aria-pressed={active}
              disabled={working}
              aria-busy={busy === code}
              onClick={() => choose(code)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm disabled:opacity-70 ${
                active
                  ? "bg-[var(--color-accent)] font-semibold text-[var(--color-accent-fg)]"
                  : "text-[var(--color-muted)]"
              }`}
            >
              {busy === code ? <Spinner /> : null}
              {LOCALE_LABELS[code]}
            </button>
          );
        })}
      </div>
      {showNote ? <span className="text-xs text-[var(--color-muted)]">{t("languageNote")}</span> : null}
      {failed ? (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {t("languageSaveFailed")}
        </span>
      ) : null}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { htmlLang, LOCALE_LABELS, LOCALES, useLocale, useT, type Locale } from "@/i18n";
import { ActionButton } from "@/components/ui/ActionButton";

/**
 * EN / 繁體中文 switch. Before sign-in it remembers the choice in this browser;
 * when signed in it is also saved for the person. The page re-renders in the
 * new language straight away.
 */
export function LanguageSwitch({ showNote = false }: { showNote?: boolean }) {
  const t = useT("common");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState<Locale | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(next: Locale) {
    if (busy || next === locale) return;
    setBusy(next);
    setFailed(false);
    try {
      const res = await fetch("/api/session/language", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!res.ok) setFailed(true);
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-component="LanguageSwitch" className="flex flex-col gap-1">
      <div
        role="group"
        aria-label={t("language")}
        aria-busy={busy !== null}
        className="inline-flex w-fit rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5"
      >
        {LOCALES.map((code) => {
          const active = code === locale;
          return (
            <ActionButton
              key={code}
              lang={htmlLang(code)}
              aria-pressed={active}
              disabled={busy !== null}
              onAction={() => choose(code)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm disabled:opacity-70 ${
                active
                  ? "bg-[var(--color-accent)] font-semibold text-[var(--color-accent-fg)]"
                  : "text-[var(--color-muted)]"
              }`}
            >
              {busy === code ? <Spinner /> : null}
              {LOCALE_LABELS[code]}
            </ActionButton>
          );
        })}
      </div>
      {showNote ? <span className="text-xs text-[var(--color-muted)]">{t("languageNote")}</span> : null}
      {failed ? (
        <span role="alert" className="text-xs text-red-300">
          {t("languageSaveFailed")}
        </span>
      ) : null}
    </div>
  );
}

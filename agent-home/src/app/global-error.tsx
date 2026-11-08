"use client";

import { useEffect, useState } from "react";

import enErrors from "@/i18n/messages/en/errors.json";
import zhErrors from "@/i18n/messages/zh-Hant/errors.json";
import { DEFAULT_LOCALE, htmlLang, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { isChunkLoadError, reloadOnceForChunkError } from "@/lib/chunk-reload";
import { DEFAULT_THEME, readStoredTheme } from "@/lib/theme";
import "./globals.css";

const STRINGS: Record<Locale, typeof enErrors> = { en: enErrors, "zh-Hant": zhErrors };

/** The visitor's language (cookie) and theme (localStorage), read in the browser. */
function readPrefs(): { locale: Locale; theme: string } {
  if (typeof document === "undefined") return { locale: DEFAULT_LOCALE, theme: DEFAULT_THEME };
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  const value = raw ? decodeURIComponent(raw) : null;
  const theme = readStoredTheme();
  return { locale: isLocale(value) ? value : DEFAULT_LOCALE, theme };
}

/**
 * The root error boundary (Next.js App Router convention — replaces the
 * whole layout, so it re-declares `<html>`/`<body>`).
 *
 * Catches the render-time half of a stale-bundle chunk-load failure (a
 * `React.lazy`/dynamic import throwing during render); the other half —
 * a background prefetch's import failing outside React's tree — is
 * `ChunkErrorListener`'s job, since this boundary never sees those.
 * A genuine application error still gets a plain, honest fallback
 * instead of Next's default "Application error" page, which named
 * nothing and pointed nowhere (the report that led here).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isStaleBundle = isChunkLoadError(error);
  // This boundary replaces the root layout, so it re-reads the person's
  // language and theme itself instead of hard-coding English on dark.
  const [{ locale, theme }] = useState(readPrefs);
  const t = STRINGS[locale];
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    reloadOnceForChunkError(error);
  }, [error]);

  if (isStaleBundle) {
    // The reload above is already in flight — nothing useful to show for
    // the instant before it lands, and no button that would just throw
    // the same error again.
    return (
      <html lang={htmlLang(locale)} data-theme={theme} suppressHydrationWarning>
        <body />
      </html>
    );
  }

  return (
    <html lang={htmlLang(locale)} data-theme={theme} suppressHydrationWarning>
      <body
        data-component="GlobalError"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-6 text-center text-[var(--color-text)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img src="/brand/illustrations/bowl-needs-a-moment.webp" alt="" width={137} height={120} className="h-[120px] w-auto" />
        <h1 className="text-xl font-semibold">{t.errorHeading}</h1>
        <p className="max-w-sm text-sm text-[var(--color-muted)]">{t.errorBody}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            disabled={retrying}
            aria-busy={retrying}
            onClick={() => {
              if (retrying) return;
              setRetrying(true);
              reset();
              window.setTimeout(() => setRetrying(false), 600);
            }}
            className="min-h-11 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {retrying ? t.retrying : t.retry}
          </button>
          {/* A full navigation: the client router may be what broke. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            className="inline-flex min-h-11 items-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 text-sm font-semibold"
          >
            {t.home}
          </a>
        </div>
        {error.message || error.digest ? (
          <details className="w-full max-w-sm text-left text-xs text-[var(--color-muted)]">
            <summary className="cursor-pointer text-center">{t.details}</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 font-mono">
              {[error.message, error.digest ? t.reference.replace("{digest}", error.digest) : null].filter(Boolean).join("\n")}
            </pre>
          </details>
        ) : null}
      </body>
    </html>
  );
}

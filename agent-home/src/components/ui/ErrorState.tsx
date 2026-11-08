"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { useT } from "@/i18n/client";

const buttonBase =
  "inline-flex items-center justify-center rounded-[var(--radius-lg)] px-4 py-2 text-sm font-semibold";

/**
 * The friendly body of the app-wide 404 and error pages: the empty-bowl brand
 * illustration, plain copy, a way back and a way home, plus Retry and the
 * raw details (collapsed) when there is an error to show.
 */
export function ErrorState({
  kind,
  onRetry,
  details,
}: {
  kind: "notFound" | "error";
  onRetry?: () => void;
  /** Technical details (message, digest) — collapsed by default. */
  details?: string | null;
}) {
  const t = useT("errors");
  const router = useRouter();

  function goBack() {
    if (window.history.length > 1) router.back();
    else router.push("/");
  }

  return (
    <section
      data-component="ErrorState"
      data-kind={kind}
      role={kind === "error" ? "alert" : undefined}
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
      <img
        src="/brand/illustrations/empty-sessions@2x.png"
        alt=""
        width={120}
        height={170}
        className="h-auto w-[120px]"
      />
      <h2 className="text-lg font-semibold text-[var(--color-text)]">
        {t(kind === "error" ? "errorHeading" : "notFoundHeading")}
      </h2>
      <p className="text-sm text-[var(--color-muted)]">
        {t(kind === "error" ? "errorBody" : "notFoundBody")}
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className={`${buttonBase} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}
          >
            {t("retry")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={goBack}
          className={`${buttonBase} border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]`}
        >
          {t("goBack")}
        </button>
        <Link
          href="/"
          className={`${buttonBase} ${
            onRetry
              ? "border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]"
              : "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
          }`}
        >
          {t("home")}
        </Link>
      </div>
      {details ? (
        <details className="mt-3 w-full text-left text-xs text-[var(--color-muted)]">
          <summary className="cursor-pointer select-none">{t("details")}</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 font-mono">
            {details}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

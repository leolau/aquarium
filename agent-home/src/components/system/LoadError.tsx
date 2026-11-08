"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/client";

/**
 * Figma `error-state` (16:143) for a System page whose first load failed:
 * a plain heading, Try again (re-runs the server render; busy until it lands)
 * and the raw error behind a disclosure.
 */
export function LoadError({ title, details, component }: { title: string; details?: string | null; component?: string }) {
  const t = useT("system");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <section
      data-component={component ?? "LoadError"}
      role="alert"
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center"
    >
      <h2 className="text-lg font-semibold text-[var(--color-fg)] [overflow-wrap:anywhere]">{title}</h2>
      <button
        type="button"
        data-action="retry"
        disabled={pending}
        aria-busy={pending}
        onClick={() => start(() => router.refresh())}
        className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
      >
        {pending ? <Spinner /> : null}
        {t("error.retry")}
      </button>
      {details ? (
        <details className="w-full text-left text-xs text-[var(--color-muted)]">
          <summary className="cursor-pointer select-none">{t("error.details")}</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 font-mono [overflow-wrap:anywhere]">
            {details}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { AuthIllustration } from "@/components/auth/AuthLayout";
import { CopyButton } from "@/components/skills/CopyButton";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/client";
import { useAction } from "@/lib/use-action";
import { logicalParent } from "@/lib/nav/route-trail";

const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60";
const primary = `${buttonBase} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`;
const secondary = `${buttonBase} border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]`;
const ghost = `${buttonBase} text-[var(--color-text)] hover:bg-[var(--color-surface-2)]`;

const JUMP_TO: { href: string; key: string }[] = [
  { href: "/chat", key: "jumpChat" },
  { href: "/projects", key: "jumpProjects" },
  { href: "/inbox", key: "jumpInbox" },
  { href: "/settings", key: "jumpSettings" },
];

/**
 * The friendly body of the app-wide 404 and error pages (Figma `error-state`
 * 16:143): a brand illustration, plain copy, Go back to the logical parent
 * (never browser history), Home, plus Retry — locked while it resets — and
 * the raw details, collapsed, with Copy details, when there is an error.
 *
 * `signedOut` swaps Home for Sign in and drops the jump links: a signed-out
 * visitor can reach nothing else yet.
 */
export function ErrorState({
  kind,
  onRetry,
  details,
  signedOut = false,
}: {
  kind: "notFound" | "error";
  onRetry?: () => void | Promise<void>;
  /** Technical details (message, digest) — collapsed by default. */
  details?: string | null;
  signedOut?: boolean;
}) {
  const t = useT("errors");
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const back = logicalParent(pathname);
  const backHref = signedOut ? "/login" : (back?.href ?? "/");
  const retry = useAction(async () => {
    await onRetry?.();
    // `reset()` re-renders the segment synchronously; hold the lock for a beat
    // so a double tap cannot fire it twice while the page re-mounts.
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  const isError = kind === "error";

  return (
    <section
      data-component="ErrorState"
      data-kind={kind}
      role={isError ? "alert" : undefined}
      className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-3 rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-8 text-center lg:px-10 lg:py-10"
    >
      <AuthIllustration name={isError ? "bowl" : "lostFish"} className="lg:h-[170px]" />
      <h2 className="mt-2 text-xl font-semibold text-[var(--color-text)] lg:text-2xl">
        {t(isError ? "errorHeading" : "notFoundHeading")}
      </h2>
      <p className="max-w-[440px] text-sm text-[var(--color-muted)] [overflow-wrap:anywhere]">
        {isError ? (
          t("errorBody")
        ) : (
          <>
            {t("notFoundBefore")}
            <code className="rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[var(--color-text)]">
              {pathname}
            </code>
            {t("notFoundAfter")}
          </>
        )}
      </p>
      <div className="mt-2 flex w-full flex-wrap justify-center gap-2">
        {onRetry ? (
          <button
            type="button"
            data-action="retry"
            disabled={retry.pending}
            aria-busy={retry.pending}
            onClick={() => void retry.run()}
            className={primary}
          >
            {retry.pending ? (
              <>
                <Spinner /> {t("retrying")}
              </>
            ) : (
              t("retry")
            )}
          </button>
        ) : null}
        <Link href={backHref} data-action="back" className={secondary}>
          {t("goBack")}
        </Link>
        <Link href={signedOut ? "/login" : "/"} className={onRetry ? ghost : primary}>
          {t(signedOut ? "signIn" : "home")}
        </Link>
      </div>
      {!isError && !signedOut ? (
        <nav aria-label={t("jumpTo")} className="mt-4 flex w-full flex-col items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{t("jumpTo")}</span>
          <ul className="flex flex-wrap justify-center gap-2">
            {JUMP_TO.map((j) => (
              <li key={j.href}>
                <Link
                  href={j.href}
                  className="inline-flex min-h-11 items-center rounded-[var(--radius-full)] border border-[var(--color-border)] px-4 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] lg:min-h-9"
                >
                  {t(j.key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {details ? (
        <details
          open={open}
          onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="mt-4 w-full text-left text-xs text-[var(--color-muted)]"
        >
          <summary className="flex min-h-11 cursor-pointer select-none items-center justify-center font-medium text-[var(--color-text)] lg:min-h-8">
            {t(open ? "hideDetails" : "details")}
          </summary>
          <p className="mt-2">{t("detailsHelp")}</p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 font-mono [overflow-wrap:anywhere]">
            {details}
          </pre>
          <CopyButton text={details} label={t("copyDetails")} className={`${secondary} mt-2`} />
        </details>
      ) : null}
    </section>
  );
}

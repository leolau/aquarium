"use client";

import { useEffect } from "react";

import { ShellFrame } from "@/components/ShellFrame";
import { ErrorState } from "@/components/ui/ErrorState";
import { useT } from "@/i18n/client";

/**
 * App-wide error boundary. A client boundary can't render the async
 * MobileShell, so it draws the same frame (no launcher: its data reads may be
 * what failed) around a friendly message, Retry and the collapsed details.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT("errors");

  useEffect(() => {
    console.error(error);
  }, [error]);

  const details = [error.message, error.digest ? t("reference", { digest: error.digest }) : null]
    .filter(Boolean)
    .join("\n");

  return (
    <ShellFrame title={t("errorTitle")}>
      <ErrorState kind="error" onRetry={reset} details={details || null} />
    </ShellFrame>
  );
}

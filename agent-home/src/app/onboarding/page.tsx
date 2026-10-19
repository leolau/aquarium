import { MobileShell } from "@/components/MobileShell";
import { BackupsItem } from "@/components/get-ready/BackupsItem";
import { backupsT } from "@/components/get-ready/backups-t";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { OffsiteBackupStatus, OnboardingReadinessResponse } from "@/types";

export const dynamic = "force-dynamic";

/**
 * FG-20 Wave B3 — onboarding wizard + readiness. BFF: resolves the principal
 * and reads the FG-15 readiness projection (`/api/onboarding/readiness`).
 * Read-only — fixes run on the CLI. Reached from Home (no bottom-nav slot).
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const isOwner = principal.role === "owner";

  let readiness: OnboardingReadinessResponse | null = null;
  let backups: OffsiteBackupStatus | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    [readiness, backups] = await Promise.all([
      client.onboardingReadiness(),
      // Owner only (Get ready item 10); the browser retries if this read fails.
      isOwner ? client.offsiteBackup().catch(() => null) : Promise.resolve(null),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load readiness";
  }

  return (
    <MobileShell title="Getting started">
      {error || !readiness ? (
        <div
          data-component="OnboardingError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load setup readiness{error ? ` (${error})` : ""}.
        </div>
      ) : (
        <OnboardingWizard readiness={readiness} />
      )}
      {isOwner ? (
        <section data-component="GetReadyKeepSafe" className="mt-4 flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            {backupsT("en")("group")}
          </h2>
          <ul className="flex flex-col gap-3">
            <BackupsItem initial={backups} />
          </ul>
        </section>
      ) : null}
    </MobileShell>
  );
}

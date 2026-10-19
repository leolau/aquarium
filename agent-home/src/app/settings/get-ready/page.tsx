import { BackupsItem } from "@/components/get-ready/BackupsItem";
import { SecurityBasicsItem } from "@/components/get-ready/SecurityBasicsItem";
import { translate } from "@/components/get-ready/securityBasicsStrings";
import { MobileShell } from "@/components/MobileShell";
import type { SecurityBasicsResult } from "@/lib/api/security-basics";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { OffsiteBackupStatus } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings → Get ready. Item 10 "Backups" (owner only): offsite encrypted
 * copies. Item 11 "Security basics" (owner/admin): read-only server checks
 * with a plain fix for each. Other items join this page as they are built.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const admin = canAdminister(principal);
  const owner = principal.role === "owner";
  let initial: SecurityBasicsResult | undefined;
  let backups: OffsiteBackupStatus | null = null;
  if (admin) {
    const client = await apiClientForRequest();
    // Unreachable: each item loads its own data and says so if that fails too.
    [initial, backups] = await Promise.all([
      client.securityBasics().catch(() => undefined),
      owner ? client.offsiteBackup().catch(() => null) : Promise.resolve(null),
    ]);
  }
  return (
    <MobileShell title={translate("en", "pageTitle")}>
      <div className="mx-auto max-w-3xl space-y-3">
        {owner ? (
          <ul className="space-y-3">
            <BackupsItem initial={backups} />
          </ul>
        ) : null}
        {admin ? (
          <SecurityBasicsItem initial={initial} />
        ) : (
          <p className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
            {translate("en", "pageAdminOnly")}
          </p>
        )}
      </div>
    </MobileShell>
  );
}

import { SecurityBasicsItem } from "@/components/get-ready/SecurityBasicsItem";
import { translate } from "@/components/get-ready/securityBasicsStrings";
import { MobileShell } from "@/components/MobileShell";
import type { SecurityBasicsResult } from "@/lib/api/security-basics";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/**
 * Settings → Get ready. Item 11 "Security basics" (owner/admin): read-only
 * server checks with a plain fix for each. Other items join this page as
 * they are built.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const admin = canAdminister(principal);
  let initial: SecurityBasicsResult | undefined;
  if (admin) {
    try {
      initial = await (await apiClientForRequest()).securityBasics();
    } catch {
      // Unreachable: the item loads it itself and says so if that fails too.
    }
  }
  return (
    <MobileShell title={translate("en", "pageTitle")}>
      <div className="mx-auto max-w-3xl space-y-3">
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

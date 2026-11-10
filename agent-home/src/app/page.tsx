import { MobileShell } from "@/components/MobileShell";
import { LandingClient } from "@/components/landing/LandingClient";
import { activeEnrolments, enrolmentRoles, type ProfileRole } from "@/lib/api/my-profiles";
import { accountName } from "@/lib/auth/account-name";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { storageConfigured } from "@/lib/env";
import type { ProfileSummary } from "@/types";

export const dynamic = "force-dynamic";

/**
 * The landing page (docs/design/landing-redesign): top bar, chats sidebar,
 * the centre composer, and the needs-you / background-work panel. The page
 * only reads what the first paint needs; every panel polls its own data and
 * keeps the last good copy, so one failing upstream never blanks the page.
 */
export default async function HomePage() {
  const principal = await requirePrincipal();
  const currentProfile = (await readSession())?.profile ?? "default";

  let profiles: ProfileSummary[] = [];
  let roles: ProfileRole[] = [];
  try {
    const client = await apiClientForRequest();
    const mine = await client.myProfiles();
    profiles = activeEnrolments(mine);
    roles = enrolmentRoles(mine);
  } catch {
    // The composer still works with only the current profile.
  }

  return (
    <MobileShell title="Aquarium" bare>
      <LandingClient
        profiles={profiles}
        currentProfile={currentProfile}
        accountName={accountName(principal)}
        accountRole={principal.role ?? null}
        accountRoles={roles}
        storageEnabled={storageConfigured()}
      />
    </MobileShell>
  );
}

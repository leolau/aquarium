import Link from "next/link";

import { SwitchToProfileButton } from "@/components/SwitchToProfileButton";
import { MobileShell } from "@/components/MobileShell";
import { edgeCard, edgeGhost, edgePrimary, edgeSecondary } from "@/components/ui/edgeStyles";
import { Pill } from "@/components/ui/Pill";
import { getT } from "@/i18n/server";
import { activeEnrolments } from "@/lib/api/my-profiles";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { ACTING_PROFILE } from "@/lib/nav/profile-gate";

export const dynamic = "force-dynamic";

/**
 * Shown in place of a whole-box page while the session works in another
 * profile (FG-28 B3; `lib/nav/profile-gate.ts`). The
 * middleware rewrites the request here, so the address bar keeps the URL and
 * switching back to the default profile re-renders the real page. Open chat
 * stays in the current profile; Switch locks until the refreshed page lands.
 */
export default async function Page() {
  await requirePrincipal();
  const t = await getT("edge");
  const profile = (await readSession())?.profile ?? ACTING_PROFILE;
  let canSwitchBack = false;
  try {
    const client = await apiClientForRequest();
    canSwitchBack = activeEnrolments(await client.myProfiles()).some(
      (p) => p.name === ACTING_PROFILE,
    );
  } catch {
    // Offer only the chat link; the header switcher still lists the profiles.
  }
  return (
    <MobileShell title={t("dpoTitle")}>
      <section data-component="DefaultProfileOnly" className={edgeCard}>
        <Pill tone="accent">{t("dpoPill")}</Pill>
        <h2 className="mt-1 text-xl font-semibold">{t("dpoHeading")}</h2>
        <p className="max-w-[460px] text-sm text-[var(--color-muted)]">
          {t("dpoBodyBefore")}
          <strong className="text-[var(--color-text)]">{profile}</strong>
          {t("dpoBodyAfter")}
        </p>
        <div className="mt-2 flex w-full flex-wrap items-center justify-center gap-2">
          {canSwitchBack ? (
            <SwitchToProfileButton
              profile={ACTING_PROFILE}
              label={t("dpoSwitch")}
              busyLabel={t("dpoSwitching")}
              className={edgePrimary}
            />
          ) : null}
          <Link href="/chat" className={canSwitchBack ? edgeSecondary : edgePrimary}>
            {t("dpoOpenChat")}
          </Link>
          <Link href="/" data-action="back" className={edgeGhost}>
            {t("goBack")}
          </Link>
        </div>
        {canSwitchBack ? <p className="text-xs text-[var(--color-muted)]">{t("dpoNote")}</p> : null}
      </section>
    </MobileShell>
  );
}

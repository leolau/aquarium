import Link from "next/link";

import { SwitchToProfileButton } from "@/components/SwitchToProfileButton";
import { MobileShell } from "@/components/MobileShell";
import { activeEnrolments } from "@/lib/api/my-profiles";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { ACTING_PROFILE } from "@/lib/nav/profile-gate";

export const dynamic = "force-dynamic";

/**
 * Shown in place of a page that still reads only the default profile while
 * the session works in another (FG-28 B3; `lib/nav/profile-gate.ts`). The
 * middleware rewrites the request here, so the address bar keeps the URL and
 * switching back to the default profile re-renders the real page.
 */
export default async function Page() {
  await requirePrincipal();
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
    <MobileShell title="Default profile only">
      <section
        data-component="DefaultProfileOnly"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center"
      >
        <p className="text-base font-medium">
          This page is available in the default profile only for now.
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          You&apos;re working in <strong>{profile}</strong>. Chat and Users already follow the
          profile you pick; the other pages will soon.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/chat"
            className="inline-block rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
          >
            Open chat
          </Link>
          {canSwitchBack ? <SwitchToProfileButton profile={ACTING_PROFILE} /> : null}
        </div>
      </section>
    </MobileShell>
  );
}

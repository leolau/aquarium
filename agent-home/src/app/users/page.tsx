import { MobileShell } from "@/components/MobileShell";
import { PAGE_SIZE } from "@/components/users/api";
import { UsersView } from "@/components/users/UsersView";
import { administeredProfiles, selectUsersProfile } from "@/lib/api/my-profiles";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { explicitProfile } from "@/lib/profile";
import type { DirectoryResponse, MembersResponse, Principal, ProfileSummary } from "@/types";

// Reads the live principal (cookie), the directory and — for an admin — the
// first roster page, per request. Never at build time.
export const dynamic = "force-dynamic";

/**
 * FG-26 — the **Users** screen, replacing `/members`.
 *
 * Unlike the old roster this page is not owner/admin-only: every enrolled
 * principal may read the directory, because somebody who cannot see who else is
 * in the profile cannot address or delegate to them. Management (enrolment,
 * roles, activation links, import, audit) is loaded only for owner/admin, and
 * every BFF route re-checks that gate — as does Python, which is the authority.
 *
 * Both lists come from **this profile's** principals. The box-wide account table
 * is deliberately never the source: one Supabase serves every profile, so
 * listing accounts would expose people enrolled somewhere else entirely.
 *
 * FG-28 C3: `?profile=` picks which profile to administer, from the profiles the
 * account is owner/admin of. Anything else — unknown, suspended, member-only —
 * falls back to the session's profile, and the role shown is the one held in
 * the profile shown (`whoami?profile=`).
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requirePrincipal();
  const sessionProfile = (await readSession())?.profile ?? "default";
  const params = await searchParams;
  const requested = explicitProfile(params.profile);

  let administered: ProfileSummary[] = [];
  try {
    administered = administeredProfiles(await (await apiClientForRequest()).myProfiles());
  } catch {
    // Enrolments unreadable: no switcher, and the session's profile is shown.
  }
  const profile = selectUsersProfile(requested, administered, sessionProfile);
  const client = await apiClientForRequest({ profile });

  // The session principal is the snapshot for the session's profile only; in
  // any other the acting principal is whoever Python says it is there.
  let actor: Principal = principal;
  let error: string | null = null;
  if (profile !== sessionProfile) {
    try {
      const answer = await client.whoami();
      if (answer.principal) actor = answer.principal;
      else error = `not enrolled in ${profile}`;
    } catch (err) {
      error = err instanceof Error ? err.message : `not enrolled in ${profile}`;
    }
  }
  const canManage = actor.role === "owner" || actor.role === "admin";

  let directory: DirectoryResponse = { configured: false, entries: [], total: 0 };
  let page: MembersResponse | null = null;
  if (!error) {
    try {
      directory = await client.directory({ limit: 200 });
      if (canManage) page = await client.members({ limit: PAGE_SIZE, offset: 0 });
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load users";
    }
  }

  return (
    <MobileShell title="Users">
      {error ? (
        <div
          data-component="UsersError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load users ({error}).
        </div>
      ) : (
        <UsersView
          key={profile}
          role={actor.role}
          userId={actor.user_id}
          profile={profile}
          administered={administered}
          directory={directory}
          initialPage={page}
        />
      )}
    </MobileShell>
  );
}

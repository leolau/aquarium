import type { ReactNode } from "react";

import { AppMcpBridge } from "@/components/app-mcp/AppMcpBridge";
import { CoralHost } from "@/components/coral/CoralHost";
import { LeadChatHost } from "@/components/coral/LeadChatHost";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { PageHeader } from "@/components/shell/PageHeader";
import { ShellTopBar } from "@/components/shell/ShellTopBar";
import { ShellFrame } from "@/components/ShellFrame";
import { getPrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { HermesApiClient } from "@/lib/api/client";
import { activeEnrolments, enrolmentRoles, type ProfileRole } from "@/lib/api/my-profiles";
import { storageConfigured } from "@/lib/env";
import { getHiddenApps } from "@/lib/nav/hidden-apps";
import type { Crumb } from "@/lib/nav/route-trail";
import type { MyProfilesResponse, ProfileSummary, Role, TodosFacets } from "@/types";

// Cache the facets call for 30s so every page render doesn't hit the backend
// for a badge count.  The hermesToken argument becomes part of the cache
// key, so each principal gets an isolated entry — the count is never
// served cross-principal.  readSession/cookies() are called outside the
// cached function (in the component body) because Next 15 rejects
// cookies() inside unstable_cache.
import { unstable_cache } from "next/cache";

const getCachedFacets = unstable_cache(
  // unstable_cache keys on the arguments, so each profile has its own count.
  async (hermesToken: string, profile: string) => {
    const client = new HermesApiClient({ hermesToken, profile });
    return client.todosFacets();
  },
  ["todos-facets-badge"],
  // The badge is decorative — a 2-minute-old count is fine, and it cuts
  // hits on the facets endpoint (the per-render backend hotspot).
  { revalidate: 120 },
);

// The header switcher's options (FG-28): the account's active enrolments.
// Cached per token like the badge; a stale list only offers a choice the
// switch endpoint re-checks against the target profile.
const getCachedMyProfiles = unstable_cache(
  async (hermesToken: string): Promise<MyProfilesResponse> =>
    new HermesApiClient({ hermesToken }).myProfiles(),
  ["my-profiles-switcher-roles"],
  { revalidate: 60 },
);

/**
 * The app shell (FG-20; Coral migration).
 *
 * Navigation is the Coral floating launcher (`CoralHost`) — one component on
 * every viewport, no tab bar, no sidebar. The shell provides the sticky
 * safe-area header, the centred content column, and mounts Coral once.
 *
 * - **Phone (base):** a single phone-width column.
 * - **Tablet (`md`):** the content column widens so it stops looking like a
 *   phone stuck in the middle of the screen.
 * - **Desktop (`lg`+):** the content area fills the remaining width (centred,
 *   with a comfortable max) — a real responsive webapp, not a phone frame.
 *
 * Feature panels render into `children`. `showCoral={false}` (e.g. the login
 * page) drops the launcher and its reserved space. `wide` lifts the desktop
 * max width for panels that lay out side-by-side columns (the memory map next
 * to its list) — at `max-w-5xl` both columns are too narrow to be readable.
 * `fill` pins the shell to the viewport height and makes `children` a flex
 * column that fills it, for panels with their own scroller (the chat thread).
 */
export async function MobileShell({
  title,
  children,
  showCoral = true,
  wide = false,
  fill = false,
  actions,
  bare = false,
  subtitle,
  info,
  back,
  labels,
  hideHeader = false,
}: {
  title: string;
  children: ReactNode;
  showCoral?: boolean;
  wide?: boolean;
  /** Fill the viewport height: `children` get a `flex-1 min-h-0` column. */
  fill?: boolean;
  /** Optional action elements rendered in the header bar, right-aligned next to the title. */
  actions?: ReactNode;
  /** Full-width page that brings its own top bar (the landing page): no
   * header, no status/activity strips, no centred column. Coral stays. */
  bare?: boolean;
  /** One-line explanation under the title. */
  subtitle?: ReactNode;
  /** Tap-to-open tip next to the title (`InfoTip`). */
  info?: ReactNode;
  /** Override the logical parent Back target (default: route table). */
  back?: Crumb;
  /** Breadcrumb label overrides by href (e.g. the project's name). */
  labels?: Record<string, string>;
  /** Top bar and launcher only, no Back row or page title (the root loading screen). */
  hideHeader?: boolean;
}) {
  // The badge count: one cached facets call per 30s.  The session is
  // resolved outside the cache so cookies() isn't called inside it, and
  // the token makes each principal's cache entry distinct.
  let badgeCounts: Record<string, number> = {};
  let hiddenApps: string[] = [];
  let enrolments: ProfileSummary[] = [];
  let sessionProfile = "default";
  let accountName: string | null = null;
  let accountRole: Role | null = null;
  let accountRoles: ProfileRole[] = [];
  if (showCoral) {
    try {
      const principal = await getPrincipal();
      if (principal) {
        accountName = principal.display || null;
        accountRole = principal.role ?? null;
        const session = await readSession();
        hiddenApps = await getHiddenApps(principal, session?.hermesToken);
        sessionProfile = session?.profile ?? sessionProfile;
        if (session?.hermesToken) {
          const mine = await getCachedMyProfiles(session.hermesToken).catch(() => ({ profiles: [] }));
          enrolments = activeEnrolments(mine);
          accountRoles = enrolmentRoles(mine);
        }
        if (session?.hermesToken) {
          const facets: TodosFacets = await getCachedFacets(
            session.hermesToken,
            sessionProfile,
          );
          const openCount =
            facets.stages.find((s) => s.value === "open")?.count ?? 0;
          if (openCount > 0) {
            badgeCounts = { "todos-open": openCount };
          }
        }
      }
    } catch {
      // Best-effort: a facets failure must not blank the page.
    }
  }
  if (bare) {
    return (
      <div data-component="MobileShell" data-variant="bare" className="min-h-dvh bg-[var(--color-bg)]">
        {children}
        {showCoral ? <CoralHost badgeCounts={badgeCounts} hiddenApps={hiddenApps} /> : null}
        {showCoral ? <LeadChatHost storageEnabled={storageConfigured()} /> : null}
        {showCoral ? <AppMcpBridge /> : null}
      </div>
    );
  }
  if (!showCoral) {
    return (
      <ShellFrame
        title={title}
        wide={wide}
        fill={fill}
        headerEnd={actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      >
        {children}
      </ShellFrame>
    );
  }
  return (
    <ShellFrame
      title={title}
      wide={wide}
      fill={fill}
      clearLauncher
      topBar={
        <ShellTopBar
          accountName={accountName}
          accountRole={accountRole}
          accountRoles={accountRoles}
          currentProfile={sessionProfile}
        />
      }
      pageHeader={
        hideHeader ? null : (
        <PageHeader
          title={title}
          subtitle={subtitle}
          info={info}
          back={back}
          labels={labels}
          actions={
            enrolments.length > 1 || actions ? (
              <>
                <ProfileSwitcher profiles={enrolments} current={sessionProfile} />
                {actions}
              </>
            ) : null
          }
        />
        )
      }
      overlays={
        <>
          <CoralHost badgeCounts={badgeCounts} hiddenApps={hiddenApps} />
          <LeadChatHost storageEnabled={storageConfigured()} />
          <AppMcpBridge />
        </>
      }
    >
      {children}
    </ShellFrame>
  );
}

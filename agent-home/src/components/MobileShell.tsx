import type { ReactNode } from "react";

import { AppMcpBridge } from "@/components/app-mcp/AppMcpBridge";
import { CoralHost } from "@/components/coral/CoralHost";
import { LeadChatHost } from "@/components/coral/LeadChatHost";
import { StatusStrip } from "@/components/ui/StatusStrip";
import { getPrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { HermesApiClient } from "@/lib/api/client";
import { storageConfigured } from "@/lib/env";
import { getHiddenApps } from "@/lib/nav/hidden-apps";
import type { TodosFacets } from "@/types";

// Cache the facets call for 30s so every page render doesn't hit the backend
// for a badge count.  The hermesToken argument becomes part of the cache
// key, so each principal gets an isolated entry — the count is never
// served cross-principal.  readSession/cookies() are called outside the
// cached function (in the component body) because Next 15 rejects
// cookies() inside unstable_cache.
import { unstable_cache } from "next/cache";

const getCachedFacets = unstable_cache(
  async (hermesToken: string) => {
    const client = new HermesApiClient({ hermesToken });
    return client.todosFacets();
  },
  ["todos-facets-badge"],
  // The badge is decorative — a 2-minute-old count is fine, and it cuts
  // hits on the facets endpoint (the per-render backend hotspot).
  { revalidate: 120 },
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
 */
export async function MobileShell({
  title,
  children,
  showCoral = true,
  wide = false,
  actions,
}: {
  title: string;
  children: ReactNode;
  showCoral?: boolean;
  wide?: boolean;
  /** Optional action elements rendered in the header bar, right-aligned next to the title. */
  actions?: ReactNode;
}) {
  // The badge count: one cached facets call per 30s.  The session is
  // resolved outside the cache so cookies() isn't called inside it, and
  // the token makes each principal's cache entry distinct.
  let badgeCounts: Record<string, number> = {};
  let hiddenApps: string[] = [];
  if (showCoral) {
    try {
      const principal = await getPrincipal();
      if (principal) {
        const session = await readSession();
        hiddenApps = await getHiddenApps(principal, session?.hermesToken);
        if (session?.hermesToken) {
          const facets: TodosFacets = await getCachedFacets(
            session.hermesToken,
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
  const contentWidth = wide ? "lg:max-w-7xl" : "lg:max-w-5xl";
  return (
    <div data-component="MobileShell" className="min-h-dvh bg-[var(--color-bg)]">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col md:max-w-2xl lg:max-w-none">
        <header
          className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 px-4 py-3 backdrop-blur lg:px-8"
          style={{ paddingTop: "calc(var(--safe-top) + 0.75rem)" }}
        >
          <div className={`mx-auto flex w-full max-w-2xl items-center justify-between gap-2 ${contentWidth}`}>
            <h1 className="text-base font-semibold tracking-tight lg:text-lg">
              {title}
            </h1>
            {actions ? (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            ) : null}
          </div>
        </header>
        {showCoral ? <StatusStrip /> : null}
        <main
          className={`flex-1 px-4 py-4 lg:px-8 ${
            showCoral
              ? "pb-[calc(var(--coral-clearance)+var(--safe-bottom)+1rem)] lg:pb-8"
              : "pb-[calc(var(--safe-bottom)+1rem)]"
          }`}
        >
          <div className={`mx-auto w-full max-w-2xl ${contentWidth}`}>
            {children}
          </div>
        </main>
        {showCoral ? <CoralHost badgeCounts={badgeCounts} hiddenApps={hiddenApps} /> : null}
        {showCoral ? <LeadChatHost storageEnabled={storageConfigured()} /> : null}
        {showCoral ? <AppMcpBridge /> : null}
      </div>
    </div>
  );
}

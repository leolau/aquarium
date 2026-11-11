import Link from "next/link";

import { MobileShell } from "@/components/MobileShell";
import { SitesList, type SiteListItem } from "@/components/sites/SitesList";
import { ErrorState } from "@/components/ui/ErrorState";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";

import { loadDirectory } from "./data";

export const dynamic = "force-dynamic";

/**
 * **Sites** (site-to-schema, plan 2026-11-10-001): websites the agent keeps as
 * tables. Hermes returns only the sites this person owns or was granted, and
 * `can_create` from `sites.create_roles` decides whether Add site shows.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("sites");

  let items: SiteListItem[] | null = null;
  let canCreate = false;
  let error: string | null = null;
  let people: Record<string, string> = {};
  try {
    const client = await apiClientForRequest();
    const [doc, directory] = await Promise.all([client.sites(), loadDirectory(client)]);
    canCreate = doc.can_create;
    people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
    items = await Promise.all(
      doc.sites.map(async (site) => {
        const runs = await client.siteRuns(site.id).catch(() => ({ runs: [] }));
        return { site, lastRun: runs.runs[0] ?? null };
      }),
    );
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load sites";
  }

  return (
    <MobileShell
      title={t("title")}
      subtitle={t("subtitle")}
      wide
      actions={
        canCreate ? (
          <Link
            href="/sites/new"
            className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)]"
          >
            {t("list.add")}
          </Link>
        ) : null
      }
    >
      {items === null ? (
        <div data-component="SitesError">
          <ErrorState kind="error" details={error} />
        </div>
      ) : (
        <SitesList items={items} people={people} me={principal.user_id} canCreate={canCreate} />
      )}
    </MobileShell>
  );
}

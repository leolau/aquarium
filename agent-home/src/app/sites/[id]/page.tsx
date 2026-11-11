import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { SiteDetail } from "@/components/sites/SiteDetail";
import { isSiteTab } from "@/components/sites/format";
import { ErrorState } from "@/components/ui/ErrorState";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { SiteGrant } from "@/types/sites";

import { loadDirectory } from "../data";

export const dynamic = "force-dynamic";

/**
 * One site. A site the viewer can't see is a 404 from Hermes (existence is
 * not revealed), so it renders as Not found here too. Grants are loaded only
 * for admins — the route is admin-only.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ tab?: string | string[] }>;
}) {
  const principal = await requirePrincipal();
  const { id } = await params;
  const query = await searchParams;
  const tab = Array.isArray(query?.tab) ? query?.tab[0] : query?.tab;
  const t = await getT("sites");

  const client = await apiClientForRequest();
  let loaded;
  try {
    const { site } = await client.site(id);
    const admin = site.access === "admin";
    const [designs, tables, runs, grants, directory] = await Promise.all([
      client.siteDesigns(id),
      client.siteTables(id).catch(() => ({ tables: [] })),
      client.siteRuns(id).catch(() => ({ runs: [] })),
      admin ? client.siteGrants(id).then((g): SiteGrant[] => g.grants) : Promise.resolve(null),
      loadDirectory(client),
    ]);
    loaded = { site, designs: designs.designs, tables: tables.tables, runs: runs.runs, grants, directory };
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 404) notFound();
    return (
      <MobileShell title={t("title")} wide>
        <ErrorState kind="error" details={err instanceof Error ? err.message : String(err)} />
      </MobileShell>
    );
  }

  return (
    <MobileShell title={loaded.site.name} wide labels={{ [`/sites/${id}`]: loaded.site.name }}>
      <SiteDetail
        site={loaded.site}
        designs={loaded.designs}
        tables={loaded.tables}
        runs={loaded.runs}
        grants={loaded.grants}
        directory={loaded.directory}
        me={principal.user_id}
        initialTab={isSiteTab(tab) ? tab : "design"}
      />
    </MobileShell>
  );
}

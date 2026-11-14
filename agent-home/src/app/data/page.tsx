import { MobileShell } from "@/components/MobileShell";
import { DataList } from "@/components/data/DataList";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { DataSource } from "@/types/data";

import { loadDirectory } from "../sites/data";

export const dynamic = "force-dynamic";

/** **Data** (plan 2026-11-14-001): Supabase sources and the dictionary answers use. Hermes filters by access. */
export default async function Page() {
  await requirePrincipal();
  const t = await getT("data");
  let sources: DataSource[] | null = null;
  let people: Record<string, string> = {};
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const [doc, directory] = await Promise.all([client.dataSources(), loadDirectory(client)]);
    sources = doc.sources;
    people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load data sources";
  }
  return (
    <MobileShell title={t("title")} subtitle={t("subtitle")} info={<InfoTip label={t("info")}>{t("infoBody")}</InfoTip>} wide>
      {sources === null ? <ErrorState kind="error" details={error} /> : <DataList sources={sources} people={people} />}
    </MobileShell>
  );
}

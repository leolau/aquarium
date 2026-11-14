import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { DictionaryDetail } from "@/components/data/DictionaryDetail";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";

import { loadDirectory } from "../../sites/data";

export const dynamic = "force-dynamic";

/** One source's dictionary. No access is a 404 from Hermes, so it renders as Not found. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePrincipal();
  const { id } = await params;
  const t = await getT("data");
  const client = await apiClientForRequest();
  let loaded;
  try {
    const [doc, versions, directory] = await Promise.all([client.dataSource(id), client.dataVersions(id), loadDirectory(client)]);
    loaded = { doc, versions: versions.versions, directory };
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 404) notFound();
    return (
      <MobileShell title={t("title")} wide>
        <ErrorState kind="error" details={err instanceof Error ? err.message : String(err)} />
      </MobileShell>
    );
  }
  const name = loaded.doc.source.name;
  return (
    <MobileShell title={name} wide labels={{ [`/data/${id}`]: name }} info={<InfoTip label={t("info")}>{t("infoBody")}</InfoTip>}>
      <DictionaryDetail doc={loaded.doc} versions={loaded.versions} directory={loaded.directory} />
    </MobileShell>
  );
}

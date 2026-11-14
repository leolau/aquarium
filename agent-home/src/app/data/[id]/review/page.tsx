import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { ReviewDraft } from "@/components/data/ReviewDraft";
import { ErrorState } from "@/components/ui/ErrorState";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";

import { loadDirectory } from "../../../sites/data";

export const dynamic = "force-dynamic";

/** Review a source's open draft (owner/admins approve; proposers see it read-only). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePrincipal();
  const { id } = await params;
  const t = await getT("data");
  const client = await apiClientForRequest();
  let loaded;
  try {
    const [doc, directory] = await Promise.all([client.dataSource(id), loadDirectory(client)]);
    loaded = { doc, directory };
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 404) notFound();
    return (
      <MobileShell title={t("review.title")} wide>
        <ErrorState kind="error" details={err instanceof Error ? err.message : String(err)} />
      </MobileShell>
    );
  }
  const name = loaded.doc.source.name;
  return (
    <MobileShell title={t("review.title")} subtitle={name} wide labels={{ [`/data/${id}`]: name }}>
      <ReviewDraft doc={loaded.doc} directory={loaded.directory} />
    </MobileShell>
  );
}

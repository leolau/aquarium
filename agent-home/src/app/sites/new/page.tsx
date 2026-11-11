import { MobileShell } from "@/components/MobileShell";
import { AddSiteForm } from "@/components/sites/AddSiteForm";
import { ErrorState } from "@/components/ui/ErrorState";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { DirectoryEntry } from "@/types";

import { loadDirectory } from "../data";

export const dynamic = "force-dynamic";

/** Add site — only for roles in `sites.create_roles` (Hermes re-checks on POST). */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("sites");

  let canCreate: boolean | null = null;
  let directory: DirectoryEntry[] = [];
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const [settings, people] = await Promise.all([client.siteSettings(), loadDirectory(client)]);
    canCreate = settings.can_create;
    directory = people;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load site settings";
  }

  return (
    <MobileShell title={t("add.title")} subtitle={t("add.subtitle")}>
      {canCreate === null ? (
        <ErrorState kind="error" details={error} />
      ) : canCreate ? (
        <AddSiteForm people={directory} me={principal.user_id} />
      ) : (
        <InlineAlert tone="info" title={t("add.notAllowedTitle")}>
          {t("add.notAllowedBody")}
        </InlineAlert>
      )}
    </MobileShell>
  );
}

import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/**
 * Route-level loading UI for **Settings → Tools**: the page header paints on tap with a
 * skeleton in the page's shape while the server waits on the backend, instead
 * of the previous page sitting frozen.
 */
export default async function Loading() {
  const t = await getT("settings");
  return (
    <MobileShell title={t("entry.tools")} subtitle={t("entry.tools.hint")}>
      <PageSkeleton rows={4} />
    </MobileShell>
  );
}

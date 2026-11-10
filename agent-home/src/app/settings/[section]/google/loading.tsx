import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/**
 * Route-level loading UI for **Google client**: the page header paints on tap with a
 * skeleton in the page's shape while the server waits on the backend, instead
 * of the previous page sitting frozen.
 */
export default async function Loading() {
  const t = await getT("googleClient");
  return (
    <MobileShell title={t("pageTitle")} subtitle={t("pageSubtitle")} wide>
      <PageSkeleton rows={3} />
    </MobileShell>
  );
}

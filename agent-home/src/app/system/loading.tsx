import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/**
 * Route-level loading UI for **System**: the page header paints on tap with a
 * skeleton in the page's shape while the server waits on the backend, instead
 * of the previous page sitting frozen.
 */
export default async function Loading() {
  const t = await getT("system");
  return (
    <MobileShell title={t("title")} subtitle={t("subtitle")} wide>
      <PageSkeleton rows={6} />
    </MobileShell>
  );
}

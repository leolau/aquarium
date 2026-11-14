import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

export default async function Loading() {
  const t = await getT("data");
  return (
    <MobileShell title={t("title")} subtitle={t("subtitle")} wide>
      <PageSkeleton rows={4} />
    </MobileShell>
  );
}

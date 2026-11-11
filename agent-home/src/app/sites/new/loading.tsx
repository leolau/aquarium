import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

export default async function Loading() {
  const t = await getT("sites");
  return (
    <MobileShell title={t("add.title")} subtitle={t("add.subtitle")}>
      <PageSkeleton rows={4} />
    </MobileShell>
  );
}

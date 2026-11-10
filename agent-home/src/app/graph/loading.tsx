import { GraphSkeleton } from "@/components/gts/GraphSkeleton";
import { MobileShell } from "@/components/MobileShell";
import { InfoTip } from "@/components/ui/InfoTip";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/**
 * Route-level loading UI for **Graph**.
 *
 * The page waits on the whole goal → task → skill graph before it can render,
 * which takes seconds on a large box. The same header paints on tap with goal
 * cards in the page's grid, and a "still working…" line if the wait runs long.
 */
export default async function Loading() {
  const t = await getT("system");
  return (
    <MobileShell
      title={t("cards.graph.name")}
      subtitle={t("graph.subtitle")}
      info={<InfoTip label={t("graph.info")}>{t("graph.infoBody")}</InfoTip>}
      wide
    >
      <PageSkeleton label={t("graph.loading")}>
        <GraphSkeleton />
      </PageSkeleton>
    </MobileShell>
  );
}

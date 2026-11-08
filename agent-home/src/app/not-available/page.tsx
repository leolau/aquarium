import Link from "next/link";

import { AquariumMark } from "@/components/brand/AquariumMark";
import "@/components/coral/coral-apps";
import { getApps } from "@/components/coral/coral-registry";
import { MobileShell } from "@/components/MobileShell";
import { edgeCard, edgePrimary, edgeSecondary } from "@/components/ui/edgeStyles";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { requirePrincipal } from "@/lib/auth/principal";

export const dynamic = "force-dynamic";

/**
 * Shown in place of a page whose menu item is hidden from the caller's role
 * (Settings → Menu). The middleware rewrites the request here, so the address
 * bar keeps the original URL. Back and Go back lead Home (the logical parent).
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  await requirePrincipal();
  const t = await getT("edge");
  const { app } = await searchParams;
  const name = getApps().find((a) => a.id === app)?.name;
  return (
    <MobileShell title={t("naTitle")}>
      <section data-component="NotAvailableForRole" className={edgeCard}>
        <AquariumMark size={56} title="" />
        <h2 className="mt-2 text-xl font-semibold">{t("naHeading")}</h2>
        <p className="text-base font-medium">
          {name ? t("naAppBody", { name }) : t("naBody")}
        </p>
        <p className="max-w-[440px] text-sm text-[var(--color-muted)]">{t("naWhy")}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Link href="/" data-action="back" className={edgeSecondary}>
            {t("goBack")}
          </Link>
          <Link href="/" className={edgePrimary}>
            {t("home")}
          </Link>
        </div>
        <p className="mt-2 flex items-center gap-1 text-xs text-[var(--color-muted)]">
          {t("naNeedAccess")}
          <InfoTip label={t("naWhoTitle")}>{t("naWhoBody")}</InfoTip>
        </p>
      </section>
    </MobileShell>
  );
}

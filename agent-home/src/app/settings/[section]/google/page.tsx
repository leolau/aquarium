import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { ConnectedAccounts } from "@/components/settings/ConnectedAccounts";
import { GoogleClientSetup } from "@/components/settings/GoogleClientSetup";
import { InfoTip } from "@/components/ui/InfoTip";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { getT } from "@/i18n/server";
import { requirePrincipal } from "@/lib/auth/principal";

export const dynamic = "force-dynamic";

/**
 * Settings → In&Out → Connect Google. Step A (owner, once) is the numbered
 * six-step guide; step B (each person) is Connected accounts below it.
 */
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section !== "in-out") notFound();
  const principal = await requirePrincipal();
  const t = await getT("googleClient");
  const ts = await getT("settings");
  return (
    <MobileShell
      title={t("pageTitle")}
      subtitle={t("pageSubtitle")}
      info={<InfoTip label={t("pageInfoLabel")}>{t("pageInfo")}</InfoTip>}
      labels={{ "/settings/in-out": ts("entry.in-out") }}
      wide
    >
      <div data-component="ConnectGooglePage" className="flex flex-col gap-6">
        {principal.is_owner ? <GoogleClientSetup /> : <InlineAlert tone="info">{t("ownerOnly")}</InlineAlert>}
        <div id="connected-accounts" className="scroll-mt-24">
          <ConnectedAccounts />
        </div>
      </div>
    </MobileShell>
  );
}

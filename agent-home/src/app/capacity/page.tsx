import { MobileShell } from "@/components/MobileShell";
import { CapacityRefresh } from "@/components/capacity/CapacityRefresh";
import { CapacityView } from "@/components/capacity/CapacityView";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { CapacityResponse } from "@/types";

// Reads live indicators per request — a cached headroom reading is a wrong one.
export const dynamic = "force-dynamic";

/**
 * FG-31 — the **Capacity** screen: where the box stands before things get slow.
 *
 * Readable by every enrolled principal: nothing here is another profile's data
 * (counts and RSS, never who is talking), and the person who notices "it feels
 * slow" is rarely the owner. The reading is box-wide because the resource is —
 * the active-session registry is per profile, so Python aggregates it.
 */
export default async function Page() {
  await requirePrincipal();

  let capacity: CapacityResponse | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    capacity = await client.capacity();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to read capacity";
  }

  const t = await getT("settings");
  return (
    <MobileShell
      title={t("entry.capacity")}
      subtitle={t("capacity.subtitle")}
      info={<InfoTip label={t("capacity.infoLabel")}>{t("capacity.info")}</InfoTip>}
      actions={<CapacityRefresh />}
      wide
    >
      {capacity === null ? (
        <div data-component="CapacityError">
          <ErrorState kind="error" details={error} />
        </div>
      ) : (
        <CapacityView capacity={capacity} />
      )}
    </MobileShell>
  );
}

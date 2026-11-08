import { TraceTimeline } from "@/components/activity/TraceTimeline";
import { MobileShell } from "@/components/MobileShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { TracesResponse } from "@/types";

export const dynamic = "force-dynamic";

const EMPTY: TracesResponse = { configured: false, traces: [] };

/**
 * FG-20 Wave B2 — Activity tab: the C8 interaction-trace timeline. BFF: the
 * server resolves the principal and calls the Python API `/api/comms/traces`
 * (C2-scoped upstream), then renders the mobile timeline. Read-only.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string | string[] }>;
}) {
  await requirePrincipal();
  const raw = (await searchParams).channel;
  const channel = (Array.isArray(raw) ? raw[0] : raw) || null;

  let data = EMPTY;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    data = await client.traces(50);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load traces";
  }

  const t = await getT("settings");
  return (
    <MobileShell
      title={t("entry.activity")}
      subtitle={t("activity.subtitle")}
      info={<InfoTip label={t("activity.infoLabel")}>{t("activity.info")}</InfoTip>}
      wide
    >
      {error ? (
        <div data-component="ActivityError">
          <ErrorState kind="error" details={error} />
        </div>
      ) : (
        <TraceTimeline traces={data.traces} configured={data.configured} channel={channel} />
      )}
    </MobileShell>
  );
}

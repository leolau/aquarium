import { TraceDetail } from "@/components/activity/TraceDetail";
import { MobileShell } from "@/components/MobileShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { TraceDetailResponse } from "@/types";

export const dynamic = "force-dynamic";

/**
 * FG-20 Wave B2 — one C8 trace's event timeline. BFF: resolves the principal
 * and calls the Python API `/api/comms/traces/{id}` (C2-scoped upstream).
 */
export default async function Page({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  await requirePrincipal();
  const { traceId } = await params;

  let detail: TraceDetailResponse = {
    configured: false,
    trace_id: traceId,
    interactions: [],
    rollup: null,
  };
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    detail = await client.trace(traceId);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load trace";
  }

  const t = await getT("settings");
  return (
    <MobileShell title={`Trace ${traceId.slice(0, 12)}`} subtitle={t("trace.subtitle")} wide>
      {error ? (
        <div data-component="TraceDetailError">
          <ErrorState kind="error" details={error} />
        </div>
      ) : (
        <TraceDetail detail={detail} />
      )}
    </MobileShell>
  );
}

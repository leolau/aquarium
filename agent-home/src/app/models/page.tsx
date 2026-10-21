import { MobileShell } from "@/components/MobileShell";
import { ModelsView } from "@/components/models/ModelsView";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { ModelsOverviewResponse } from "@/types";

export const dynamic = "force-dynamic";

/**
 * System ▸ Models — which brains are configured and which are actually in
 * use. BFF: resolves the principal and loads the model overview (main slot,
 * auxiliary task roles, 30-day usage) from the Python API in one fan-out,
 * then hands it to the interactive {@link ModelsView}. Slot changes route
 * back through `/api/models/*` to the dashboard's `/api/model/*` endpoints;
 * provider keys go through `/api/models/provider-key` to `/api/env`.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ profile?: string }>;
}) {
  await requirePrincipal();
  const { profile: requestedProfile } = await searchParams;
  const profile = (requestedProfile ?? "").trim() || undefined;

  let data: ModelsOverviewResponse | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest({ profile });
    const [info, auxiliary, analytics, fallback] = await Promise.all([
      client.modelInfo(),
      client.auxiliaryModels(),
      // Usage and backups are additive — they must not blank the configuration sections.
      client.modelsAnalytics(30).catch(() => null),
      client.fallbackModels().catch(() => null),
    ]);
    data = {
      info,
      auxiliary,
      usage: analytics?.models ?? [],
      fallback: fallback?.providers ?? [],
    };
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load models";
  }

  return (
    <MobileShell title="Models">
      {error || !data ? (
        <div
          data-component="ModelsError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load model settings ({error ?? "no data"}).
        </div>
      ) : (
        <ModelsView initial={data} profile={profile} />
      )}
    </MobileShell>
  );
}

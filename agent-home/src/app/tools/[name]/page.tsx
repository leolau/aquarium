import Link from "next/link";

import { MobileShell } from "@/components/MobileShell";
import { LoadError } from "@/components/system/LoadError";
import { ToolDetailView, type ToolDetailData } from "@/components/tools/ToolDetailView";
import type { AppHealth } from "@/components/tools/toolsModel";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { datastoreMode } from "@/lib/env";
import type { StoreMode, Tool } from "@/types";

export const dynamic = "force-dynamic";

/**
 * `/tools/[name]`: one app's status, URLs, last build, deployments, logs,
 * feedback and MCP status. Read as the caller, so C2 decides visibility.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams?: Promise<{ mode?: string | string[] }>;
}) {
  const principal = await requirePrincipal();
  const t = await getT("tools");
  const ts = await getT("system");
  const { name } = await params;
  const rawMode = (await searchParams)?.mode;
  const mode: StoreMode = rawMode === "dev" || rawMode === "prod" ? rawMode : datastoreMode();
  const path = `/api/tools/${encodeURIComponent(name)}`;

  let data: ToolDetailData | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const raw = await client.request<ToolDetailData | Tool>(`${path}?mode=${mode}`);
    // The Python read is the flat tool row plus its `runtime` row (runtime_state,
    // health, lifecycle_state), which is the health shape the view reads.
    data = "tool" in raw
      ? raw
      : { tool: raw, health: (raw as Tool & { runtime?: AppHealth | null }).runtime ?? null };
    if (!data.mcp) {
      data.mcp = await client
        .request<NonNullable<ToolDetailData["mcp"]>>(`${path}/mcp?mode=${mode}`)
        .catch(() => null);
    }
  } catch (err) {
    if (!(err instanceof HermesApiError && (err.status === 404 || err.status === 403))) {
      error = err instanceof Error ? err.message : "Failed to load the app";
    }
  }

  const viewer = { user_id: principal.user_id, role: principal.role, is_owner: principal.is_owner };
  return (
    <MobileShell
      title={data ? data.tool.display_name || data.tool.name : t("title")}
      labels={data ? { [`/tools/${encodeURIComponent(name)}`]: data.tool.display_name || data.tool.name } : undefined}
      wide
    >
      <div className="pb-24 lg:pb-8">
        {data ? (
          <ToolDetailView data={data} viewer={viewer} />
        ) : error ? (
          <LoadError component="ToolsError" title={ts("pages.tool.loadError")} details={error} />
        ) : (
          <div
            data-component="ToolsError"
            className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center"
          >
            <p className="text-sm text-[var(--color-muted)]">{ts("pages.tool.notFound")}</p>
            <Link
              href="/tools"
              className="inline-flex min-h-11 items-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 text-sm font-medium"
            >
              {t("detail.back")}
            </Link>
          </div>
        )}
      </div>
    </MobileShell>
  );
}

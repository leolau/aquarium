import Link from "next/link";

import { MobileShell } from "@/components/MobileShell";
import { ToolDetailView, type ToolDetailData } from "@/components/tools/ToolDetailView";
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
  const { name } = await params;
  const rawMode = (await searchParams)?.mode;
  const mode: StoreMode = rawMode === "dev" || rawMode === "prod" ? rawMode : datastoreMode();
  const path = `/api/tools/${encodeURIComponent(name)}`;

  let data: ToolDetailData | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const raw = await client.request<ToolDetailData | Tool>(`${path}?mode=${mode}`);
    data = "tool" in raw ? raw : { tool: raw };
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
    <MobileShell title={data ? data.tool.display_name || data.tool.name : t("title")}>
      <div className="flex flex-col gap-4">
        <Link href="/tools" className="text-sm text-[var(--color-accent)] underline">
          ← {t("detail.back")}
        </Link>
        {data ? (
          <ToolDetailView data={data} viewer={viewer} />
        ) : (
          <p data-component="ToolsError" className="text-sm text-[var(--color-muted)]">
            {error ? t("loadFailed", { error }) : t("notFound")}
          </p>
        )}
      </div>
    </MobileShell>
  );
}

import { MobileShell } from "@/components/MobileShell";
import { ToolsRegistry, type ToolsPageData } from "@/components/tools/ToolsRegistry";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { datastoreMode } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Home → Tools v2 (FG-33 §7). One batch read of `/api/tools?include=health`
 * as the logged-in person, so the grid shows only their own and shared apps
 * and no tile polls on its own.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("tools");

  const mode = datastoreMode();
  let data: ToolsPageData = { configured: false, mode, tools: [] };
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    data = await client.request<ToolsPageData>(`/api/tools?mode=${mode}&include=health`);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load tools";
  }

  const viewer = { user_id: principal.user_id, role: principal.role, is_owner: principal.is_owner };
  return (
    <MobileShell title={t("title")}>
      {error ? (
        <div
          data-component="ToolsError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          {t("loadFailed", { error })}
        </div>
      ) : (
        <ToolsRegistry data={data} viewer={viewer} />
      )}
    </MobileShell>
  );
}

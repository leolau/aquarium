import Link from "next/link";

import { chatHandOffUrl } from "@/components/landing/startChat";
import { MobileShell } from "@/components/MobileShell";
import { LoadError } from "@/components/system/LoadError";
import { ToolsRegistry, type ToolsPageData } from "@/components/tools/ToolsRegistry";
import { quotaSummary, type ToolQuotaResponse } from "@/components/tools/toolsModel";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { datastoreMode } from "@/lib/env";

export const dynamic = "force-dynamic";

/** "Build an app": a fresh agent chat with the request prefilled (not sent), so the person finishes the sentence. */
function buildAppUrl(prompt: string): string {
  const url = new URL(chatHandOffUrl(prompt), "http://x");
  url.searchParams.delete("autosend");
  return `${url.pathname}${url.search}`;
}

/**
 * Home → Tools v2 (FG-33 §7). One batch read of `/api/tools?include=health`
 * as the logged-in person, so the grid shows only their own and shared apps
 * and no tile polls on its own.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("tools");
  const ts = await getT("system");

  const mode = datastoreMode();
  let data: ToolsPageData = { configured: false, mode, tools: [] };
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const [list, quota] = await Promise.all([
      client.request<ToolsPageData>(`/api/tools?mode=${mode}&include=health`),
      client.request<ToolQuotaResponse>("/api/tools/quota").catch(() => null),
    ]);
    data = { ...list, quota: list.quota ?? quotaSummary(quota) };
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load tools";
  }

  const viewer = { user_id: principal.user_id, role: principal.role, is_owner: principal.is_owner };
  return (
    <MobileShell
      title={t("title")}
      wide
      actions={
        <Link
          href={buildAppUrl(ts("pages.tools.buildPrompt"))}
          data-action="build-app"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-3.5 text-sm font-semibold text-[var(--color-accent-fg)] lg:min-h-9"
        >
          <span aria-hidden>+</span>
          {ts("pages.tools.buildApp")}
        </Link>
      }
    >
      {error ? (
        <LoadError component="ToolsError" title={ts("pages.tools.loadError")} details={error} />
      ) : (
        <div className="pb-24 lg:pb-8">
          <ToolsRegistry data={data} viewer={viewer} />
        </div>
      )}
    </MobileShell>
  );
}

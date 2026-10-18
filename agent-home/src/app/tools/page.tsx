import { MobileShell } from "@/components/MobileShell";
import { ToolsRegistry } from "@/components/tools/ToolsRegistry";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { datastoreMode } from "@/lib/env";
import type { ToolsResponse } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Home → Tools: apps the agent has built or installed (the tool registry),
 * read-only. Reads `/api/tools` as the logged-in person for agent-home's own
 * datastore mode, so each person sees their own entries plus shared ones.
 */
export default async function Page() {
  await requirePrincipal();

  const mode = datastoreMode();
  let data: ToolsResponse = { configured: false, mode, tools: [] };
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    data = await client.tools(mode);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load tools";
  }

  return (
    <MobileShell title="Tools">
      {error ? (
        <div
          data-component="ToolsError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load the list of apps ({error}).
        </div>
      ) : (
        <ToolsRegistry data={data} />
      )}
    </MobileShell>
  );
}

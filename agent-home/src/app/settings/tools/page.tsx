import { MobileShell } from "@/components/MobileShell";
import { ToolsSettings } from "@/components/settings/ToolsSettings";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canManageTools } from "@/lib/auth/roles";
import type { McpServer, Toolset } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings → Tools & Integrations: the MCP servers and the tool groups
 * Aquarium chats run with — enable/disable, probe, remove, and the
 * browser-driven OAuth re-auth flow for `auth: oauth` servers (Canva & co).
 * Members and viewers see the same lists read-only.
 */
export default async function Page() {
  const principal = await requirePrincipal();

  let servers: McpServer[] | null = null;
  let toolsets: Toolset[] | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const [mcp, ts] = await Promise.all([
      client.mcpServers(),
      client.toolsets(),
    ]);
    servers = mcp.servers;
    toolsets = ts;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load tools";
  }

  return (
    <MobileShell title="Tools & Integrations">
      {error ? (
        <div
          data-component="ToolsSettingsError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load the integrations ({error}).
        </div>
      ) : (
        <ToolsSettings
          servers={servers ?? []}
          toolsets={toolsets ?? []}
          canManage={canManageTools(principal)}
        />
      )}
    </MobileShell>
  );
}

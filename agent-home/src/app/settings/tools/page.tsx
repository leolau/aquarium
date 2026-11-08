import { MobileShell } from "@/components/MobileShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { PersonalMcpServers } from "@/components/settings/PersonalMcpServers";
import { RoleLimitsSection } from "@/components/settings/RoleLimitsSection";
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

  const t = await getT("settings");
  return (
    <MobileShell
      title={t("entry.tools")}
      subtitle={t("entry.tools.hint")}
      info={<InfoTip label={t("tools.infoLabel")}>{t("tools.info")}</InfoTip>}
    >
      <PersonalMcpServers />
      {error ? (
        <div data-component="ToolsSettingsError">
          <ErrorState kind="error" details={error} />
        </div>
      ) : (
        <ToolsSettings
          servers={servers ?? []}
          toolsets={toolsets ?? []}
          canManage={canManageTools(principal)}
        />
      )}
      <RoleLimitsSection canEdit={principal.role === "owner" || principal.role === "admin"} />
    </MobileShell>
  );
}

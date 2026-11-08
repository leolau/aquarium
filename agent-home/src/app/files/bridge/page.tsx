import { MobileShell } from "@/components/MobileShell";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";

import { FilesTabs } from "@/components/files/FilesTabs";
import { FolderBridgeView } from "@/components/files/FolderBridgeView";
import { requirePrincipal } from "@/lib/auth/principal";

// Per-principal; the picker/WebSocket state lives entirely client-side, but
// the page itself still requires a signed-in principal like every other
// agent-home screen.
export const dynamic = "force-dynamic";

/**
 * `/files/bridge` — Folder Bridge (see `folder-bridge-web-app-spec.md`).
 *
 * A live, opt-in bridge from local Mac folders to the running agent, over
 * the `app-mcp` service's folder hub (`folder_bridge_*` MCP tools). Nothing
 * here is server-rendered beyond the shell — the File System Access API and
 * the WebSocket are both browser-only.
 */
export default async function Page() {
  await requirePrincipal();
  const tf = await getT("filesBrowse");
  const ts = await getT("settings");
  return (
    <MobileShell
      title={tf("title")}
      subtitle={ts("files.subtitle")}
      info={<InfoTip label={ts("files.infoLabel")}>{ts("files.info")}</InfoTip>}
      wide
      back={{ href: "/", label: "Home" }}
    >
      <FilesTabs />
      <FolderBridgeView />
    </MobileShell>
  );
}

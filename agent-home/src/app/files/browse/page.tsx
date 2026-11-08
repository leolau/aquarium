import { MobileShell } from "@/components/MobileShell";
import { InfoTip } from "@/components/ui/InfoTip";

import { BrowseView } from "@/components/files/BrowseView";
import { FilesTabs } from "@/components/files/FilesTabs";
import { getT } from "@/i18n/server";
import { requirePrincipal } from "@/lib/auth/principal";

// Per-principal: which network folders and workspace the caller may open.
export const dynamic = "force-dynamic";

/**
 * `/files/browse` — click through folders, read-only: folders on this
 * computer (Folder Bridge, listed by the browser), network folders the caller
 * may open, and their own workspace. Everything loads client-side, one folder
 * level per request.
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
    >
      <FilesTabs />
      <BrowseView />
    </MobileShell>
  );
}

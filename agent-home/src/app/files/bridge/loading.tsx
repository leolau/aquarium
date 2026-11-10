import { FilesTabs } from "@/components/files/FilesTabs";
import { MobileShell } from "@/components/MobileShell";
import { InfoTip } from "@/components/ui/InfoTip";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";
import { FolderBridgeSkeleton } from "@/components/files/FilesSkeletons";

/**
 * Route-level loading UI for **Files → Folder bridge**: the same header and tabs as the
 * page, with placeholders in the shape of the view, so a tap paints at once
 * while the server waits on the backend.
 */
export default async function Loading() {
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
      <PageSkeleton label={tf("loadingFolders")}>
        <FolderBridgeSkeleton />
      </PageSkeleton>
    </MobileShell>
  );
}

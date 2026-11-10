import { FolderBridgeSkeleton } from "@/components/files/FilesSkeletons";
import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { getT } from "@/i18n/server";

/** Route-level loading UI for **Folder Bridge** — the Folder bridge's card layout. */
export default async function Loading() {
  const tf = await getT("filesBrowse");
  return (
    <MobileShell title="Folder Bridge">
      <PageSkeleton label={tf("loadingFolders")}>
        <FolderBridgeSkeleton />
      </PageSkeleton>
    </MobileShell>
  );
}

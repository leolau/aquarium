import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** Route-level loading UI while a short ref resolves (FG-36). */
export default function Loading() {
  return (
    <MobileShell title="Opening…">
      <PageSkeleton rows={2} />
    </MobileShell>
  );
}

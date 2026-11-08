import { SeminarShell } from "@/components/seminar/SeminarShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * Route-level loading UI for the seminar **survey**. Visitors arrive from a QR
 * code, signed out, so this keeps them in the seminar shell instead of the
 * root skeleton and its launcher.
 */
export default function Loading() {
  return (
    <SeminarShell>
      <PageSkeleton rows={2} label="載入中… Loading…" />
    </SeminarShell>
  );
}

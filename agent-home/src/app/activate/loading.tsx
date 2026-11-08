import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * Route-level loading UI for **Activate your account**. The visitor is signed
 * out, so this overrides the root skeleton, which would flash the launcher.
 */
export default function Loading() {
  return (
    <MobileShell title="Activate your account" showCoral={false}>
      <PageSkeleton rows={1} label="Loading activation…" />
    </MobileShell>
  );
}

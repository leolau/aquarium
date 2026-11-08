import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * Route-level loading UI for **Setup**. The visitor is signed out, so this
 * overrides the root skeleton, which would flash the Aquarium launcher.
 */
export default function Loading() {
  return (
    <MobileShell title="Set up Aquarium" showCoral={false} wide>
      <PageSkeleton rows={2} label="Loading setup…" />
    </MobileShell>
  );
}

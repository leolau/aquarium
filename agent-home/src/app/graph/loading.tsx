import { MobileShell } from "@/components/MobileShell";
import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * Route-level loading UI for **GTS Centre**.
 *
 * The page is a `force-dynamic` server component, so navigating to it blocks on
 * the upstream reads. Without this file the browser kept showing the page the
 * user was leaving, with no sign anything was happening. Now the shell and a
 * skeleton paint on tap, and the real content replaces them when it arrives.
 */
export default function Loading() {
  return (
    <MobileShell title="Graph">
      <PageSkeleton rows={4} />
    </MobileShell>
  );
}

import { MobileShell } from "@/components/MobileShell";
import { RouteLoading } from "@/components/ui/RouteLoading";

/**
 * Route-level loading UI for **Getting started**.
 *
 * The page is a `force-dynamic` server component, so navigating to it blocks on
 * the upstream reads. Without this file the browser kept showing the page the
 * user was leaving, with no sign anything was happening. Now the shell and the
 * Aquarium loader paint on tap, and the real content replaces them when it arrives.
 */
export default function Loading() {
  return (
    <MobileShell title="Getting started">
      <RouteLoading />
    </MobileShell>
  );
}

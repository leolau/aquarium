import { MobileShell } from "@/components/MobileShell";
import { RouteLoading } from "@/components/ui/RouteLoading";

/**
 * Route-level loading UI for **Aquarium**.
 *
 * The page is a `force-dynamic` server component, so navigating to it blocks on
 * the upstream reads. Without this file the browser kept showing the page the
 * user was leaving, with no sign anything was happening. Now the shell and the
 * Aquarium loader paint on tap, and the real content replaces them. As in the
 * Figma "loading" frames (24:5279 / 24:5894) only the top bar and launcher
 * frame the loader: there is no page title or Back row yet.
 */
export default function Loading() {
  return (
    <MobileShell title="Aquarium" hideHeader>
      <RouteLoading />
    </MobileShell>
  );
}

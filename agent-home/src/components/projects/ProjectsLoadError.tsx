"use client";

import { useRouter } from "next/navigation";

import { ErrorState } from "@/components/ui/ErrorState";

/**
 * A Projects page whose data didn't load: the shared friendly error (Try
 * again re-runs the server render; Back / Home are ErrorState's own), under
 * the page's existing `data-component` hook.
 */
export function ProjectsLoadError({ component, details }: { component: string; details?: string | null }) {
  const router = useRouter();
  return (
    <div data-component={component}>
      <ErrorState kind="error" onRetry={() => router.refresh()} details={details} />
    </div>
  );
}

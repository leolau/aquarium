import type { ActivityItem } from "@/types";
import type { NeedsYouEntry, NeedsYouResponse } from "@/types/landing";

/** Realistic sample data for tests and the screenshot harness. */
export function needsYouEntry(over: Partial<NeedsYouEntry> = {}): NeedsYouEntry {
  return {
    id: "ny-1",
    source: "project_checkpoint",
    severity: "approval",
    title: "Run 4 is waiting at a checkpoint",
    detail: "Website relaunch",
    context: { project_slug: "website-relaunch", run_no: 4 },
    created_at: 1_700_000_000 - 8 * 60,
    href: "/projects/website-relaunch/runs/4",
    actions: [{ id: "review", label: "Review", style: "primary", href: "/projects/website-relaunch/runs/4" }],
    reversible: false,
    ...over,
  };
}

export function needsYouResponse(items: NeedsYouEntry[]): NeedsYouResponse {
  const by: NeedsYouResponse["by_severity"] = { blocking: 0, approval: 0, review: 0, fyi: 0 };
  for (const i of items) by[i.severity] += 1;
  return { items, count: items.length, by_severity: by, collected_at: 1_700_000_000 };
}

export function activityItem(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    kind: "project_run",
    id: "r1",
    name: "Market research digest",
    started_at: 1_700_000_000 - 12 * 60,
    href: "/projects/market-research",
    profile: null,
    status: "running",
    ...over,
  };
}

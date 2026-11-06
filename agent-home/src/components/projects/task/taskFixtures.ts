import type { ProjectListItem } from "@/types";

/** A one-off task list row for tests. */
export function item(over: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: over.slug ?? "p",
    slug: "p",
    name: "A task",
    cadence: "one_off",
    status: "active",
    archived: false,
    health: "ok",
    created_at: 1_700_000_000,
    latest_run: null,
    output_rollup: { total: 1, required: 1, delivered: 0, accepted: 0, awaiting_acceptance: 0 },
    ...over,
  } as ProjectListItem;
}

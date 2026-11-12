/**
 * The to-do filter vocabulary and its URL codec.
 *
 * Deliberately **not** a `"use client"` module: `/todos/page.tsx` renders on
 * the server and needs the real values. Exports of a client module reach a
 * server component as client-reference proxies, so `DEFAULT_STAGES.join(",")`
 * there fails at runtime with "join is not a function" — in the production
 * build only, which is where it was found.
 */

export interface TodosFilterState {
  q: string;
  stages: string[];
  priorities: string[];
  sourceRef: string;
  includeSnoozed: boolean;
}

/**
 * The default view is the live work: staged, open, working and review —
 * a draft awaiting verdict is still live work the user owes attention.
 *
 * Done and dismissed to-dos are not deleted — the audit trail is the point —
 * but a list that shows every to-do the agent ever closed is a list nobody
 * reads twice.
 */
export const DEFAULT_STAGES = ["staged", "open", "working", "review"];

export const EMPTY_FILTERS: TodosFilterState = {
  q: "",
  stages: DEFAULT_STAGES,
  priorities: [],
  sourceRef: "",
  includeSnoozed: false,
};

/** Read the filter state out of a shared `/todos?…` URL. */
export function filtersFromParams(params: URLSearchParams): TodosFilterState {
  const csv = (key: string) =>
    (params.get(key) ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  const stages = csv("stage");
  return {
    q: params.get("q") ?? "",
    stages: stages.length > 0 ? stages : DEFAULT_STAGES,
    priorities: csv("priority"),
    sourceRef: params.get("source_ref") ?? "",
    includeSnoozed: params.get("include_snoozed") === "true",
  };
}

/** The inverse, for the address bar and for the BFF call. */
export function filtersToParams(
  value: TodosFilterState,
  cursor?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (value.q) params.set("q", value.q);
  if (value.stages.length > 0) params.set("stage", value.stages.join(","));
  if (value.priorities.length > 0) {
    params.set("priority", value.priorities.join(","));
  }
  if (value.sourceRef) params.set("source_ref", value.sourceRef);
  if (value.includeSnoozed) params.set("include_snoozed", "true");
  if (cursor) params.set("cursor", cursor);
  return params;
}

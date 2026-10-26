/**
 * The project list's filter vocabulary and its URL codec.
 *
 * Deliberately **not** a `"use client"` module: `/projects/page.tsx` renders
 * on the server and needs the real values. Exports of a client module reach a
 * server component as client-reference proxies, so reading `DEFAULT_VIEW`
 * there would fail at runtime in the production build only — the exact
 * incident the to-dos filters carry the scar of.
 */

/**
 * The eight chips from the design (§13): one narrows by status, cadence or
 * health, "All" lifts every restriction including the archive, and
 * "Archived" names the shelf — restore is only discoverable if a shelved
 * project can be found again. They are the list's only narrowing controls,
 * so each maps to exactly one query parameter — a shared
 * `/projects?cadence=standing` link is a shared filter.
 */
export type ProjectListView =
  | "active"
  | "repeatable"
  | "standing"
  | "attention"
  | "paused"
  | "done"
  | "all"
  | "archived";

export const FILTER_CHIPS: { view: ProjectListView; label: string }[] = [
  { view: "active", label: "Active" },
  { view: "repeatable", label: "Repeatable" },
  { view: "standing", label: "Standing" },
  { view: "attention", label: "Attention" },
  { view: "paused", label: "Paused" },
  { view: "done", label: "Done" },
  { view: "all", label: "All" },
  { view: "archived", label: "Archived" },
];

/**
 * The list defaults to the live work (acceptance §16 Frontend). The server
 * expands `status=active` to active + planning, so a just-created project
 * is on the default view while it still needs its plan.
 */
export const DEFAULT_VIEW: ProjectListView = "active";

/**
 * How `/projects` lays the matching projects out: the category board (one
 * grid tile per category, the default), or the paged list. A view
 * preference, not a filter — it rides in the URL as `layout=list` but never
 * reaches the upstream projects API.
 */
export type ProjectsLayout = "list" | "board";

export const DEFAULT_LAYOUT: ProjectsLayout = "board";

/** The `category` value that narrows the list to Uncategorized projects. */
export const UNCATEGORIZED_FILTER = "none";

export interface ProjectsFilterState {
  view: ProjectListView;
  q: string;
  layout: ProjectsLayout;
  /**
   * The list view narrowed to one category: a category id,
   * `UNCATEGORIZED_FILTER`, or "" for every category. The board ignores it
   * (it already groups by category).
   */
  category: string;
}

export const EMPTY_FILTERS: ProjectsFilterState = {
  view: DEFAULT_VIEW,
  q: "",
  layout: DEFAULT_LAYOUT,
  category: "",
};

/** Read the filter state out of a shared `/projects?…` URL. */
export function filtersFromParams(
  params: URLSearchParams,
): ProjectsFilterState {
  let view: ProjectListView = DEFAULT_VIEW;
  if (params.get("archived") === "true" && params.get("status") === "archived")
    view = "archived";
  else if (params.get("archived") === "true") view = "all";
  else if (params.get("cadence") === "repeatable") view = "repeatable";
  else if (params.get("cadence") === "standing") view = "standing";
  else if (params.get("health") === "attention") view = "attention";
  else if (params.get("status") === "paused") view = "paused";
  else if (params.get("status") === "done") view = "done";
  // `status=active` and anything unrecognised both land on the default view.
  const layout: ProjectsLayout =
    params.get("layout") === "list" ? "list" : DEFAULT_LAYOUT;
  const category = layout === "list" ? (params.get("category") ?? "") : "";
  return { view, q: params.get("q") ?? "", layout, category };
}

/**
 * The inverse, for the address bar and for the BFF call. `layout` is only
 * written for the list (absent = board); the BFF call drops it. `category`
 * is only written for the list.
 */
export function filtersToParams(
  value: ProjectsFilterState,
  cursor?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  switch (value.view) {
    case "repeatable":
      params.set("cadence", "repeatable");
      break;
    case "standing":
      params.set("cadence", "standing");
      break;
    case "attention":
      params.set("health", "attention");
      break;
    case "paused":
      params.set("status", "paused");
      break;
    case "done":
      params.set("status", "done");
      break;
    case "all":
      params.set("archived", "true");
      break;
    case "archived":
      params.set("archived", "true");
      params.set("status", "archived");
      break;
    default:
      params.set("status", "active");
  }
  if (value.q) params.set("q", value.q);
  if (value.layout === "list") {
    params.set("layout", "list");
    if (value.category) params.set("category", value.category);
  }
  if (cursor) params.set("cursor", cursor);
  return params;
}

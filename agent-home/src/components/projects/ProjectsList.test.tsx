import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import {
  CADENCE_GLYPH,
  dayDistance,
  ProjectRow,
} from "@/components/projects/ProjectRow";
import { ProjectsHomeCard } from "@/components/projects/ProjectsHomeCard";
import { ProjectsList } from "@/components/projects/ProjectsList";
import {
  DEFAULT_LAYOUT,
  DEFAULT_VIEW,
  EMPTY_FILTERS,
  UNCATEGORIZED_FILTER,
  filtersFromParams,
  filtersToParams,
} from "@/components/projects/filters";
import type { Project, ProjectCategory, ProjectListItem } from "@/types";

const DAY = 86_400;

const BASE: Project = {
  id: "prj_1",
  slug: "monday-digest",
  name: "Send the Monday digest",
  description: "The digest the team reads before standup.",
  icon: null,
  color: null,
  board_slug: null,
  primary_path: null,
  archived: false,
  created_at: 1_755_000_000,
  goal: "The team starts Monday already briefed",
  visibility: "shared",
  owner_user_id: "leo_owner",
  status: "active",
  cadence: "repeatable",
  schedule: "every monday 09:00",
  review_every: null,
  autonomy: "supervised",
  max_in_progress: 1,
  budget_usd_per_run: null,
  definition_of_done: null,
  target_audience: null,
  score_rubric: null,
  toolsets: null,
  skills: null,
  due_at: null,
  host_profile: "default",
  cron_job_id: null,
  summary: null,
  summary_at: null,
  last_reviewed_at: null,
  next_run_at: Math.floor(Date.now() / 1000) + 2 * DAY,
};

const ITEM: ProjectListItem = {
  ...BASE,
  progress: {
    rung: "outputs",
    label: "outputs",
    headline: "delivered 11 of last 12",
    accepted: 11,
    required: 12,
    cards: { total: 1, done: 1, running: 0, blocked: 0 },
  },
  member_count: 2,
  health: "ok",
};

const CATEGORIES: ProjectCategory[] = [
  {
    id: "pcat_sales",
    name: "Sales",
    color: "#f59e0b",
    position: 0,
    created_at: 1_755_000_000,
    created_by: null,
    project_count: 1,
  },
];

describe("projects filter URL round-trip", () => {
  it("defaults to the live work, so closed projects do not fill the list", () => {
    expect(filtersFromParams(new URLSearchParams()).view).toBe(DEFAULT_VIEW);
    expect(DEFAULT_VIEW).toBe("active");
    expect(filtersToParams(EMPTY_FILTERS).get("status")).toBe("active");
  });

  it("restores every shared chip URL exactly", () => {
    const cases: [string, typeof DEFAULT_VIEW][] = [
      ["status=active", "active"],
      ["cadence=repeatable", "repeatable"],
      ["cadence=standing", "standing"],
      ["health=attention", "attention"],
      ["status=paused", "paused"],
      ["status=done", "done"],
      ["archived=true", "all"],
      ["archived=true&status=archived", "archived"],
    ];
    for (const [qs, view] of cases) {
      expect(filtersFromParams(new URLSearchParams(qs)).view).toBe(view);
      // Round-trips: the same view produces the one narrowing parameter back.
      expect(filtersToParams({ ...EMPTY_FILTERS, view }).toString()).toBe(qs);
      expect(filtersToParams({ ...EMPTY_FILTERS, view, layout: "list" }).toString()).toBe(
        `${qs}&layout=list`,
      );
    }
  });

  it("carries the search and keeps the cursor out of the shareable filter", () => {
    const state = { view: "standing" as const, q: "digest", layout: "list" as const, categoryIds: [] as string[] };
    const params = filtersToParams(state, "cur_2");
    expect(params.get("q")).toBe("digest");
    expect(params.get("cursor")).toBe("cur_2");
    expect(filtersToParams(state).has("cursor")).toBe(false);
  });
});

describe("projects layout URL round-trip", () => {
  it("is the board when absent, and only `layout=list` selects the list", () => {
    expect(DEFAULT_LAYOUT).toBe("board");
    expect(filtersFromParams(new URLSearchParams()).layout).toBe("board");
    expect(filtersFromParams(new URLSearchParams("status=active")).layout).toBe("board");
    expect(filtersFromParams(new URLSearchParams("layout=grid")).layout).toBe("board");
    expect(filtersFromParams(new URLSearchParams("layout=board")).layout).toBe("board");
    expect(filtersFromParams(new URLSearchParams("layout=list")).layout).toBe("list");
    // The board never writes the parameter, so the bare URL is the board.
    expect(filtersToParams(EMPTY_FILTERS).has("layout")).toBe(false);
  });

  it("round-trips the list alongside the view and the search", () => {
    const state = { view: "standing" as const, q: "digest", layout: "list" as const, categoryIds: [] as string[] };
    const params = filtersToParams(state, "cur_2");
    expect(params.get("layout")).toBe("list");
    expect(filtersFromParams(filtersToParams(state))).toEqual(state);
    expect(filtersFromParams(new URLSearchParams("status=paused&layout=list"))).toEqual({
      view: "paused",
      q: "",
      layout: "list",
      categoryIds: [],
    });
  });

  it("round-trips a category-narrowed list, and the board drops the category", () => {
    const state = { ...EMPTY_FILTERS, layout: "list" as const, categoryIds: ["pcat_sales"] };
    expect(filtersToParams(state).toString()).toBe("status=active&layout=list&category=pcat_sales");
    expect(filtersFromParams(filtersToParams(state))).toEqual(state);
    expect(filtersFromParams(new URLSearchParams("layout=list&category=none")).categoryIds).toEqual([
      UNCATEGORIZED_FILTER,
    ]);
    expect(filtersToParams({ ...state, layout: "board" }).has("category")).toBe(false);
    expect(filtersFromParams(new URLSearchParams("category=pcat_sales")).categoryIds).toEqual([]);
  });

  it("round-trips several categories as one comma-separated parameter", () => {
    const state = {
      ...EMPTY_FILTERS,
      layout: "list" as const,
      categoryIds: ["pcat_sales", UNCATEGORIZED_FILTER],
    };
    expect(filtersToParams(state).get("category")).toBe("pcat_sales,none");
    expect(filtersFromParams(filtersToParams(state))).toEqual(state);
    expect(
      filtersFromParams(new URLSearchParams("layout=list&category=a,,b, a")).categoryIds,
    ).toEqual(["a", "b"]);
  });
});

describe("ProjectRow", () => {
  it("leads with the cadence glyph and names the health", () => {
    const html = renderToStaticMarkup(<ProjectRow project={ITEM} />);
    expect(html).toContain('data-component="ProjectRow"');
    expect(html).toContain(CADENCE_GLYPH.repeatable);
    expect(html).toContain("Send the Monday digest");
    expect(html).toContain("/projects/monday-digest");
    expect(html).toContain("ok");
  });

  it("shows the goal as the dimmed line and the backend's headline verbatim", () => {
    const html = renderToStaticMarkup(<ProjectRow project={ITEM} />);
    expect(html).toContain("The team starts Monday already briefed");
    expect(html).toContain("delivered 11 of last 12");
    expect(html).toContain("2 members");
  });

  it("reads a one-off's due date and a repeatable's next run as distances", () => {
    const oneOff = renderToStaticMarkup(
      <ProjectRow
        project={{
          ...ITEM,
          cadence: "one_off",
          due_at: Math.floor(Date.now() / 1000) + 3 * DAY,
        }}
      />,
    );
    expect(oneOff).toContain("due in 3d");
    // The next-run distance only exists when the schedule has resolved one.
    const unscheduled = renderToStaticMarkup(
      <ProjectRow project={{ ...ITEM, next_run_at: null }} />,
    );
    expect(unscheduled).not.toContain("next ");
    expect(unscheduled).toContain("every monday 09:00");
  });

  it("marks a stalled project visibly", () => {
    const html = renderToStaticMarkup(
      <ProjectRow project={{ ...ITEM, health: "stalled" }} />,
    );
    expect(html).toContain("stalled");
  });

  it("tags the card with its category's name and colour", () => {
    const html = renderToStaticMarkup(
      <ProjectRow project={{ ...ITEM, category_id: "pcat_sales" }} categories={CATEGORIES} />,
    );
    expect(html).toContain('data-component="ProjectCategoryTag"');
    expect(html).toContain('data-category-id="pcat_sales"');
    expect(html).toContain("Sales");
    expect(html).toContain("border-color:#f59e0b");
    expect(html).toContain("background-color:#f59e0b");
  });

  it("tags an uncategorized project, and hides a tag it cannot name", () => {
    const none = renderToStaticMarkup(
      <ProjectRow project={{ ...ITEM, category_id: null }} categories={CATEGORIES} />,
    );
    expect(none).toContain('data-category-id="none"');
    expect(none).toContain("Uncategorized");
    const unknown = renderToStaticMarkup(
      <ProjectRow project={{ ...ITEM, category_id: "pcat_gone" }} categories={CATEGORIES} />,
    );
    expect(unknown).not.toContain('data-component="ProjectCategoryTag"');
  });

  it("measures distances at the day grain", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(dayDistance(now + 3_600)).toBe("today");
    expect(dayDistance(now + 3 * DAY)).toBe("in 3d");
    expect(dayDistance(now - 5 * DAY)).toBe("5d ago");
  });
});

const LIST_FILTERS = { ...EMPTY_FILTERS, layout: "list" as const };

describe("ProjectsList", () => {
  it("defaults to the category board", () => {
    const html = renderToStaticMarkup(
      <ProjectsList initial={{ items: [ITEM], next_cursor: null }} />,
    );
    expect(html).toContain('data-component="ProjectsCategoryBoard"');
    expect(html).toContain('data-component="ProjectsCategoryGrid"');
    expect(html).toContain('data-component="ManageCategoriesAction"');
    expect(html).not.toContain("Load more");
  });

  it("renders the server's first page with its filters", () => {
    const html = renderToStaticMarkup(
      <ProjectsList initial={{ items: [ITEM], next_cursor: "cur_2" }} initialFilters={LIST_FILTERS} />,
    );
    expect(html).toContain('data-component="ProjectsList"');
    expect(html).toContain('data-component="ProjectsFilters"');
    expect(html).toContain("Send the Monday digest");
    // All seven chips are present — they are the lifecycle, not facets.
    for (const label of ["Active", "Repeatable", "Standing", "Attention", "Paused", "Done", "All", "Archived"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Load more");
    // The layout toggle is there in list mode; the board is not.
    expect(html).toContain('data-component="ProjectsLayoutToggle"');
    expect(html).not.toContain('data-component="ProjectsCategoryBoard"');
  });

  it("says what the page is for when there is nothing in it", () => {
    const html = renderToStaticMarkup(
      <ProjectsList initial={{ items: [], next_cursor: null }} initialFilters={LIST_FILTERS} />,
    );
    expect(html).toContain('data-component="ProjectsEmpty"');
    expect(html).toContain("a recurring job, a standing duty");
  });

  it("carries the create door in the header and in the empty state", () => {
    // A client method with no caller is the exact shape of the U1 defect:
    // the door must exist on the *rendered* page, in both states.
    const withItems = renderToStaticMarkup(
      <ProjectsList initial={{ items: [ITEM], next_cursor: null }} initialFilters={LIST_FILTERS} />,
    );
    expect(withItems).toContain('href="/projects/new"');
    expect(withItems).toContain("New project");

    const empty = renderToStaticMarkup(
      <ProjectsList initial={{ items: [], next_cursor: null }} initialFilters={LIST_FILTERS} />,
    );
    expect(empty).toContain('href="/projects/new"');
    expect(empty).toContain("New project");
  });
});

describe("ProjectsHomeCard", () => {
  it("lists each active project with its health and next run", () => {
    const html = renderToStaticMarkup(<ProjectsHomeCard items={[ITEM]} />);
    expect(html).toContain('data-component="ProjectsHomeCard"');
    expect(html).toContain("Send the Monday digest");
    expect(html).toContain("next in 2d");
    expect(html).toContain("ok");
    expect(html).toContain("/projects/monday-digest");
    expect(html).toContain('data-component="ProjectsHomeAll"');
  });

  it("shows the same project card as the list, category tag included", () => {
    const item = { ...ITEM, category_id: "pcat_sales" };
    const home = renderToStaticMarkup(<ProjectsHomeCard items={[item]} categories={CATEGORIES} />);
    expect(home).toContain(
      renderToStaticMarkup(<ProjectRow project={item} categories={CATEGORIES} />),
    );
    expect(home).toContain("Sales");
  });

  it("falls back to the schedule text before the first run is resolved", () => {
    const html = renderToStaticMarkup(
      <ProjectsHomeCard items={[{ ...ITEM, next_run_at: null }]} />,
    );
    expect(html).toContain("every monday 09:00");
  });

  it("explains the empty state instead of rendering a bare header", () => {
    const html = renderToStaticMarkup(<ProjectsHomeCard items={[]} />);
    expect(html).toContain("Nothing running right now");
  });
});

// The filters module is imported by the server page — it must stay a plain
// module, exactly like the nav model. The boundary test walks `app/`; this
// pins the cause, not just the symptom.
describe("projects/filters.ts", () => {
  it("is a server-safe module (no 'use client' directive)", () => {
    const source = readFileSync(
      resolve(__dirname, "filters.ts"),
      "utf8",
    );
    expect(source.startsWith('"use client"')).toBe(false);
    expect(source.startsWith("'use client'")).toBe(false);
  });
});

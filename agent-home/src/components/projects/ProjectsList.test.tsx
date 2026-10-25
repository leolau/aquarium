import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CADENCE_GLYPH,
  dayDistance,
  ProjectRow,
} from "@/components/projects/ProjectRow";
import { ProjectsHomeCard } from "@/components/projects/ProjectsHomeCard";
import { ProjectsList } from "@/components/projects/ProjectsList";
import {
  DEFAULT_VIEW,
  EMPTY_FILTERS,
  filtersFromParams,
  filtersToParams,
} from "@/components/projects/filters";
import type { Project, ProjectListItem } from "@/types";

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
      expect(filtersToParams({ view, q: "", layout: "list" }).toString()).toBe(qs);
    }
  });

  it("carries the search and keeps the cursor out of the shareable filter", () => {
    const state = { view: "standing" as const, q: "digest", layout: "list" as const };
    const params = filtersToParams(state, "cur_2");
    expect(params.get("q")).toBe("digest");
    expect(params.get("cursor")).toBe("cur_2");
    expect(filtersToParams(state).has("cursor")).toBe(false);
  });
});

describe("projects layout URL round-trip", () => {
  it("is the list when absent, and only `layout=board` selects the board", () => {
    expect(filtersFromParams(new URLSearchParams()).layout).toBe("list");
    expect(filtersFromParams(new URLSearchParams("layout=grid")).layout).toBe("list");
    expect(filtersFromParams(new URLSearchParams("layout=board")).layout).toBe("board");
    // The list never writes the parameter, so existing shared links are unchanged.
    expect(filtersToParams(EMPTY_FILTERS).has("layout")).toBe(false);
  });

  it("round-trips the board alongside the view and the search", () => {
    const state = { view: "standing" as const, q: "digest", layout: "board" as const };
    const params = filtersToParams(state, "cur_2");
    expect(params.get("layout")).toBe("board");
    expect(filtersFromParams(filtersToParams(state))).toEqual(state);
    expect(filtersFromParams(new URLSearchParams("status=paused&layout=board"))).toEqual({
      view: "paused",
      q: "",
      layout: "board",
    });
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
  });

  it("marks a stalled project visibly", () => {
    const html = renderToStaticMarkup(
      <ProjectRow project={{ ...ITEM, health: "stalled" }} />,
    );
    expect(html).toContain("stalled");
  });

  it("measures distances at the day grain", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(dayDistance(now + 3_600)).toBe("today");
    expect(dayDistance(now + 3 * DAY)).toBe("in 3d");
    expect(dayDistance(now - 5 * DAY)).toBe("5d ago");
  });
});

describe("ProjectsList", () => {
  it("renders the server's first page with its filters", () => {
    const html = renderToStaticMarkup(
      <ProjectsList initial={{ items: [ITEM], next_cursor: "cur_2" }} />,
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
      <ProjectsList initial={{ items: [], next_cursor: null }} />,
    );
    expect(html).toContain('data-component="ProjectsEmpty"');
    expect(html).toContain("a recurring job, a standing duty");
  });

  it("carries the create door in the header and in the empty state", () => {
    // A client method with no caller is the exact shape of the U1 defect:
    // the door must exist on the *rendered* page, in both states.
    const withItems = renderToStaticMarkup(
      <ProjectsList initial={{ items: [ITEM], next_cursor: null }} />,
    );
    expect(withItems).toContain('href="/projects/new"');
    expect(withItems).toContain("New project");

    const empty = renderToStaticMarkup(
      <ProjectsList initial={{ items: [], next_cursor: null }} />,
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

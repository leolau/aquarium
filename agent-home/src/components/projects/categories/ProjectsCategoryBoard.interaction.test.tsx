// @vitest-environment jsdom
/**
 * The `/projects` category board: grouping (column order, unknown/null →
 * Uncategorized), the move select and drag-and-drop sending the one
 * `{category_id}` PATCH, and the List | Board toggle reading every page.
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { ProjectsList } from "@/components/projects/ProjectsList";
import { PROJECT_DRAG_TYPE } from "@/components/projects/categories/ProjectCategoryCard";
import {
  groupProjectsByCategory,
  ProjectsCategoryBoard,
} from "@/components/projects/categories/ProjectsCategoryBoard";
import type { ProjectCategory, ProjectListItem } from "@/types";

const NOW = 1_755_000_000;

const CATEGORY = (over: Partial<ProjectCategory>): ProjectCategory => ({
  id: "pcat_x",
  name: "X",
  color: null,
  position: 0,
  created_at: NOW,
  created_by: null,
  project_count: 0,
  ...over,
});

const SALES = CATEGORY({ id: "pcat_sales", name: "Sales", color: "#f59e0b", position: 0 });
const RESEARCH = CATEGORY({ id: "pcat_research", name: "Research", position: 2 });
const MARKETING = CATEGORY({ id: "pcat_marketing", name: "Marketing", position: 1 });

const ITEM = (over: Partial<ProjectListItem>): ProjectListItem => ({
  id: "prj_1",
  slug: "monday-digest",
  name: "Send the Monday digest",
  description: "",
  icon: null,
  color: null,
  board_slug: null,
  primary_path: null,
  archived: false,
  created_at: NOW,
  goal: "The team starts Monday already briefed",
  visibility: "shared",
  owner_user_id: "leo_owner",
  status: "active",
  cadence: "repeatable",
  schedule: null,
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
  next_run_at: null,
  category_id: null,
  progress: {
    rung: "cards",
    label: "cards",
    headline: "1 of 2 cards done",
    cards: { total: 2, done: 1, running: 0, blocked: 0 },
  },
  member_count: 1,
  health: "ok",
  ...over,
});

const DIGEST = ITEM({ id: "prj_1", slug: "monday-digest", category_id: "pcat_sales" });
const LEADS = ITEM({ id: "prj_2", slug: "lead-list", name: "Lead list", category_id: "pcat_gone" });
const NOTES = ITEM({ id: "prj_3", slug: "field-notes", name: "Field notes", category_id: null });
const PAPERS = ITEM({ id: "prj_4", slug: "papers", name: "Papers", category_id: "pcat_research" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function columnNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('[data-component="ProjectsCategoryColumn"]'),
  ).map((node) => node.getAttribute("aria-label") ?? "");
}

describe("groupProjectsByCategory", () => {
  it("orders columns by position and ends with Uncategorized", () => {
    const columns = groupProjectsByCategory([], [RESEARCH, SALES, MARKETING]);
    expect(columns.map((c) => c.category?.name ?? "Uncategorized")).toEqual([
      "Sales",
      "Marketing",
      "Research",
      "Uncategorized",
    ]);
  });

  it("breaks position ties by created_at", () => {
    const early = CATEGORY({ id: "a", name: "Early", position: 1, created_at: NOW });
    const late = CATEGORY({ id: "b", name: "Late", position: 1, created_at: NOW + 5 });
    const names = groupProjectsByCategory([], [late, early]).map((c) => c.category?.name);
    expect(names.slice(0, 2)).toEqual(["Early", "Late"]);
  });

  it("files null, missing and unknown category ids under Uncategorized", () => {
    // An older API build that omits the field entirely.
    const legacy: ProjectListItem = ITEM({ id: "prj_5", slug: "legacy" });
    delete legacy.category_id;
    const columns = groupProjectsByCategory(
      [DIGEST, LEADS, NOTES, PAPERS, legacy],
      [SALES, RESEARCH],
    );
    const slugs = columns.map((c) => c.items.map((p) => p.slug));
    expect(slugs).toEqual([
      ["monday-digest"],
      ["papers"],
      ["lead-list", "field-notes", "legacy"],
    ]);
  });
});

describe("ProjectsCategoryBoard", () => {
  it("renders one column per category plus Uncategorized, with counts and colour dots", () => {
    const { container } = render(
      <ProjectsCategoryBoard
        items={[DIGEST, LEADS, NOTES]}
        categories={[RESEARCH, SALES]}
        onMoved={() => {}}
      />,
    );
    expect(columnNames(container)).toEqual(["Sales", "Research", "Uncategorized"]);
    const counts = Array.from(
      container.querySelectorAll('[data-component="ProjectsCategoryCount"]'),
    ).map((n) => n.textContent);
    expect(counts).toEqual(["1", "0", "2"]);
    const research = container.querySelector('[data-category="pcat_research"]')!;
    expect(research.textContent).toContain("No projects");
    const dot = container.querySelector<HTMLElement>('[data-component="ProjectsCategoryDot"]')!;
    expect(dot.style.backgroundColor).toBe("rgb(245, 158, 11)");
    const card = container.querySelector('[data-slug="monday-digest"]')!;
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/projects/monday-digest");
  });

  it("shows only Uncategorized and a hint when there are no categories", () => {
    const { container } = render(
      <ProjectsCategoryBoard items={[DIGEST]} categories={[]} onMoved={() => {}} />,
    );
    expect(columnNames(container)).toEqual(["Uncategorized"]);
    expect(container.querySelector('[data-component="ProjectsCategoryHint"]')).not.toBeNull();
  });

  it("the Move to… select sends one PATCH with the category id and patches locally", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ...NOTES, category_id: "pcat_sales" }));
    vi.stubGlobal("fetch", fetchMock);
    const onMoved = vi.fn();
    const { getByLabelText } = render(
      <ProjectsCategoryBoard items={[NOTES]} categories={[SALES]} onMoved={onMoved} />,
    );
    const select = getByLabelText("Move Field notes to…") as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "pcat_sales" } });

    await waitFor(() => expect(onMoved).toHaveBeenCalledWith("field-notes", "pcat_sales"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/projects/field-notes");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ category_id: "pcat_sales" });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    // skipRefresh: the board patches the item itself.
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("moving to Uncategorized clears the category with null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ...DIGEST, category_id: null }));
    vi.stubGlobal("fetch", fetchMock);
    const onMoved = vi.fn();
    const { getByLabelText } = render(
      <ProjectsCategoryBoard items={[DIGEST]} categories={[SALES]} onMoved={onMoved} />,
    );
    fireEvent.change(getByLabelText("Move Send the Monday digest to…"), {
      target: { value: "" },
    });
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith("monday-digest", null));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ category_id: null });
  });

  it("a refused move shows the error with Retry on that card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(422, { detail: "unknown category" })),
    );
    const onMoved = vi.fn();
    const { container, getByLabelText } = render(
      <ProjectsCategoryBoard items={[DIGEST, NOTES]} categories={[SALES]} onMoved={onMoved} />,
    );
    fireEvent.change(getByLabelText("Move Field notes to…"), {
      target: { value: "pcat_sales" },
    });
    const card = container.querySelector<HTMLElement>('[data-slug="field-notes"]')!;
    await waitFor(() =>
      expect(card.querySelector('[data-component="ActionError"]')).not.toBeNull(),
    );
    expect(within(card).getByText("Retry")).toBeTruthy();
    expect(
      container.querySelector('[data-slug="monday-digest"] [data-component="ActionError"]'),
    ).toBeNull();
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("dropping a card on another column moves it there", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ...NOTES, category_id: "pcat_sales" }));
    vi.stubGlobal("fetch", fetchMock);
    const onMoved = vi.fn();
    const { container } = render(
      <ProjectsCategoryBoard items={[NOTES]} categories={[SALES]} onMoved={onMoved} />,
    );
    const store = new Map<string, string>();
    const dataTransfer = {
      get types() {
        return Array.from(store.keys());
      },
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? "",
      effectAllowed: "all",
      dropEffect: "none",
    };
    const card = container.querySelector('[data-slug="field-notes"]')!;
    const sales = container.querySelector('[data-category="pcat_sales"]')!;
    fireEvent.dragStart(card, { dataTransfer });
    expect(store.get(PROJECT_DRAG_TYPE)).toBe("field-notes");
    fireEvent.dragOver(sales, { dataTransfer });
    fireEvent.drop(sales, { dataTransfer });

    await waitFor(() => expect(onMoved).toHaveBeenCalledWith("field-notes", "pcat_sales"));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ category_id: "pcat_sales" });
  });

  it("dropping a card on its own column sends nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <ProjectsCategoryBoard items={[DIGEST]} categories={[SALES]} onMoved={() => {}} />,
    );
    const store = new Map([[PROJECT_DRAG_TYPE, "monday-digest"]]);
    const dataTransfer = {
      types: [PROJECT_DRAG_TYPE],
      getData: (type: string) => store.get(type) ?? "",
    };
    fireEvent.drop(container.querySelector('[data-category="pcat_sales"]')!, { dataTransfer });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ProjectsList layout toggle", () => {
  it("Board writes layout=board to the URL and reads every page without sending layout upstream", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { items: [DIGEST], next_cursor: "cur_2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [NOTES], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { container, getByRole } = render(
      <ProjectsList
        initial={{ items: [DIGEST], next_cursor: "cur_2" }}
        categories={[SALES]}
      />,
    );
    expect(container.querySelector('[data-component="ProjectsCategoryBoard"]')).toBeNull();
    expect(getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(getByRole("button", { name: "Board" }));
    expect(getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-component="ProjectsCategoryBoard"]')).not.toBeNull();
    expect(container.querySelector('[data-component="ManageCategoriesAction"]')).not.toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(new URLSearchParams(window.location.search).get("layout")).toBe("board");
    const urls = fetchMock.mock.calls.map((c) => new URL(String(c[0]), "http://x"));
    for (const url of urls) {
      expect(url.pathname).toBe("/api/projects");
      expect(url.searchParams.has("layout")).toBe(false);
      expect(url.searchParams.get("limit")).toBe("200");
    }
    expect(urls[0].searchParams.has("cursor")).toBe(false);
    expect(urls[1].searchParams.get("cursor")).toBe("cur_2");
    await waitFor(() =>
      expect(container.querySelector('[data-slug="field-notes"]')).not.toBeNull(),
    );
    expect(columnNames(container)).toEqual(["Sales", "Uncategorized"]);

    fireEvent.click(getByRole("button", { name: "List" }));
    expect(container.querySelector('[data-component="ProjectsCategoryBoard"]')).toBeNull();
  });

  it("opened on a board URL with more pages, it reads the rest on mount", async () => {
    window.history.replaceState(null, "", "/projects?status=active&layout=board");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { items: [DIGEST], next_cursor: "cur_2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [NOTES], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <ProjectsList initial={{ items: [DIGEST], next_cursor: "cur_2" }} categories={[SALES]} />,
    );
    expect(container.querySelector('[data-component="ProjectsCategoryBoard"]')).not.toBeNull();
    await waitFor(() =>
      expect(container.querySelector('[data-slug="field-notes"]')).not.toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

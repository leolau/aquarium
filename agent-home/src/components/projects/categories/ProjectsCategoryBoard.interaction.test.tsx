// @vitest-environment jsdom
/**
 * The `/projects` category board: grouping (column order, unknown/null →
 * Uncategorized), the move select and drag-and-drop sending the one
 * `{category_id}` PATCH, and the List | Board toggle reading every page.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
    expect(counts).toEqual(["1 project", "0 projects", "2 projects"]);
    expect(container.querySelector('[data-component="ProjectsCategoryGrid"]')?.className).toContain(
      "grid",
    );
    const research = container.querySelector('[data-category="pcat_research"]')!;
    expect(research.textContent).toContain("No projects");
    const dot = container.querySelector<HTMLElement>('[data-component="ProjectsCategoryDot"]')!;
    expect(dot.style.backgroundColor).toBe("rgb(245, 158, 11)");
    const card = container.querySelector('[data-slug="monday-digest"]')!;
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/projects/monday-digest");
    const tag = card.querySelector<HTMLElement>('[data-component="ProjectCategoryTag"]')!;
    expect(tag.textContent).toContain("Sales");
    expect(tag.style.borderColor).toBe("rgb(245, 158, 11)");
    // The same card body as the list: the meta line comes along.
    expect(card.textContent).toContain("repeatable");
    // An id the board doesn't know files under Uncategorized with no tag.
    const leads = container.querySelector('[data-slug="lead-list"]')!;
    expect(leads.querySelector('[data-component="ProjectCategoryTag"]')).toBeNull();
    const notes = container.querySelector('[data-slug="field-notes"]')!;
    expect(notes.querySelector('[data-component="ProjectCategoryTag"]')?.textContent).toContain(
      "Uncategorized",
    );
  });

  it("each tile's List button opens the list for that category", () => {
    const onOpenList = vi.fn();
    const { getByRole } = render(
      <ProjectsCategoryBoard
        items={[DIGEST, NOTES]}
        categories={[SALES]}
        onMoved={() => {}}
        onOpenList={onOpenList}
      />,
    );
    fireEvent.click(getByRole("button", { name: "List Sales projects" }));
    expect(onOpenList).toHaveBeenLastCalledWith("pcat_sales");
    fireEvent.click(getByRole("button", { name: "List Uncategorized projects" }));
    expect(onOpenList).toHaveBeenLastCalledWith(null);
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
  it("Board drops layout=list from the URL and reads every page without sending layout upstream", async () => {
    window.history.replaceState(null, "", "/projects?status=active&layout=list");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { items: [DIGEST], next_cursor: "cur_2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [NOTES], next_cursor: null }))
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));
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
    expect(new URLSearchParams(window.location.search).has("layout")).toBe(false);
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

  it("a tile's List button opens the list narrowed to that category", async () => {
    window.history.replaceState(null, "", "/projects");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [DIGEST], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { container, getByRole } = render(
      <ProjectsList initial={{ items: [DIGEST, NOTES], next_cursor: null }} categories={[SALES]} />,
    );
    expect(getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(getByRole("button", { name: "List Sales projects" }));
    expect(getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-component="ProjectsCategoryBoard"]')).toBeNull();
    expect(
      container.querySelector('[data-component="ProjectsCategoryFilter"]')?.textContent,
    ).toContain("Category: Sales");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = new URL(String(fetchMock.mock.calls.at(-1)![0]), "http://x");
    expect(url.searchParams.get("category")).toBe("pcat_sales");
    expect(url.searchParams.has("layout")).toBe(false);
    const address = new URLSearchParams(window.location.search);
    expect(address.get("layout")).toBe("list");
    expect(address.get("category")).toBe("pcat_sales");

    // Tick a second category: both go upstream as one parameter.
    fireEvent.click(getByRole("button", { name: /Category: Sales/ }));
    fireEvent.click(getByRole("checkbox", { name: "Uncategorized" }));
    expect(
      container.querySelector('[data-component="ProjectsCategoryFilter"]')?.textContent,
    ).toContain("Category: Sales, Uncategorized");
    await waitFor(() =>
      expect(
        new URL(String(fetchMock.mock.calls.at(-1)![0]), "http://x").searchParams.get("category"),
      ).toBe("pcat_sales,none"),
    );

    // Clear lifts every category, and the filter stays to pick again.
    fireEvent.click(getByRole("button", { name: "Show every category" }));
    expect(
      container.querySelector('[data-component="ProjectsCategoryFilter"]')?.textContent,
    ).toContain("Category: All categories");
    expect(getByRole("checkbox", { name: "Sales" })).toHaveProperty("checked", false);
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).has("category")).toBe(false),
    );
    fireEvent.click(getByRole("checkbox", { name: "Sales" }));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("category")).toBe("pcat_sales"),
    );
    fireEvent.click(getByRole("button", { name: "Board" }));
    fireEvent.click(getByRole("button", { name: "List Sales projects" }));
    fireEvent.click(getByRole("button", { name: "Board" }));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).has("category")).toBe(false),
    );
  });

  it("refreshes the tiles after categories are added, renamed and deleted", async () => {
    window.history.replaceState(null, "", "/projects");
    let list: ProjectCategory[] = [SALES, MARKETING];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      if (url === "/api/project-categories" && method === "GET") {
        return jsonResponse(200, { items: list });
      }
      if (url === "/api/project-categories" && method === "POST") {
        const ops = CATEGORY({ id: "pcat_ops", name: "Operations", position: 5 });
        list = [...list, ops];
        return jsonResponse(200, ops);
      }
      if (url === "/api/project-categories/pcat_sales" && method === "PATCH") {
        list = list.map((c) =>
          c.id === "pcat_sales" ? { ...c, name: "Deals", color: "#3b82f6" } : c,
        );
        return jsonResponse(200, list[0]);
      }
      if (url === "/api/project-categories/pcat_marketing" && method === "DELETE") {
        list = list.filter((c) => c.id !== "pcat_marketing");
        return jsonResponse(200, { deleted: "pcat_marketing", uncategorized: 0 });
      }
      return jsonResponse(200, { items: [DIGEST], next_cursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container, getByRole, getByPlaceholderText, getByLabelText } = render(
      <ProjectsList initial={{ items: [DIGEST], next_cursor: null }} categories={[SALES, MARKETING]} />,
    );
    expect(columnNames(container)).toEqual(["Sales", "Marketing", "Uncategorized"]);
    fireEvent.click(getByRole("button", { name: "Manage categories" }));

    fireEvent.change(getByPlaceholderText("e.g. Sales"), { target: { value: "Operations" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Add category" }));
    });
    await waitFor(() =>
      expect(columnNames(container)).toEqual(["Sales", "Marketing", "Operations", "Uncategorized"]),
    );

    fireEvent.click(getByRole("button", { name: "Rename Sales" }));
    fireEvent.change(getByLabelText("New name for Sales"), { target: { value: "Deals" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });
    await waitFor(() =>
      expect(columnNames(container)).toEqual(["Deals", "Marketing", "Operations", "Uncategorized"]),
    );

    fireEvent.click(getByRole("button", { name: "Delete Marketing" }));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete category" }));
    });
    await waitFor(() =>
      expect(columnNames(container)).toEqual(["Deals", "Operations", "Uncategorized"]),
    );
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

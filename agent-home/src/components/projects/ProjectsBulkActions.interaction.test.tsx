// @vitest-environment jsdom
/**
 * The `/projects` list's page numbers and bulk actions: ticking projects
 * (kept across pages, dropped on a new view), Set category and Archive
 * sending each project's own request, and a refusal staying ticked.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { ProjectsList } from "@/components/projects/ProjectsList";
import { pageWindow } from "@/components/projects/ProjectsPagination";
import type { ProjectCategory, ProjectListItem } from "@/types";

const NOW = 1_755_000_000;

const SALES: ProjectCategory = {
  id: "pcat_sales",
  name: "Sales",
  color: "#f59e0b",
  position: 0,
  created_at: NOW,
  created_by: null,
  project_count: 0,
};

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


const MANY = Array.from({ length: 25 }, (_, i) =>
  ITEM({ id: `prj_${i + 1}`, slug: `p-${i + 1}`, name: `Project ${i + 1}` }),
);

type Call = { url: string; method: string; body: unknown; key: string | null };
let calls: Call[];

function stubFetch(fail: Record<string, string> = {}) {
  calls = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      key: headers["Idempotency-Key"] ?? null,
    });
    if (method === "GET") {
      return new Response(JSON.stringify({ items: MANY, next_cursor: null }), { status: 200 });
    }
    const slug = decodeURIComponent(url.split("/")[3] ?? "");
    if (fail[slug]) {
      return new Response(JSON.stringify({ detail: fail[slug] }), { status: 409 });
    }
    return new Response(JSON.stringify({ slug }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderList(items = MANY) {
  return render(
    <ProjectsList initial={{ items, next_cursor: null }} categories={[SALES]} />,
  );
}

const tick = (name: string) =>
  fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));

const writes = () => calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  window.history.replaceState(null, "", "/projects?status=active&layout=list");
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("pageWindow", () => {
  it("shows every page up to seven, then first, last and neighbours", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 10)).toEqual([1, 2, null, 10]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(10, 10)).toEqual([1, null, 9, 10]);
  });
});

describe("ProjectsList pages", () => {
  it("shows 20 a page with page numbers, and a per-page choice", () => {
    renderList();
    expect(screen.getByText("1–20 of 25")).toBeTruthy();
    expect(screen.getByText("Project 20")).toBeTruthy();
    expect(screen.queryByText("Project 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(screen.getByText("21–25 of 25")).toBeTruthy();
    expect(screen.getByText("Project 25")).toBeTruthy();
    expect(screen.queryByText("Project 1")).toBeNull();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("combobox", { name: "Per page" }), {
      target: { value: "10" },
    });
    expect(screen.getByText("1–10 of 25")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 3" })).toBeTruthy();
  });

  it("keeps ticks across pages; select-all covers only the page shown", () => {
    renderList();
    tick("Project 1");
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    // 1 from page 1 + the 5 on page 2.
    expect(screen.getByText("6 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unselect all" }));
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("drops ticks and goes back to page 1 when the view changes", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    tick("Project 21");
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Paused" }));
    expect(screen.queryByText("1 selected")).toBeNull();
  });
});

describe("ProjectsList bulk actions", () => {
  it("moves every ticked project with its own category PATCH", async () => {
    renderList();
    tick("Project 1");
    tick("Project 2");
    fireEvent.change(screen.getByRole("combobox", { name: "New category" }), {
      target: { value: "pcat_sales" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply category" }));
    });
    await waitFor(() => expect(screen.getByText(/Moved 2 projects to Sales/)).toBeTruthy());
    expect(writes().map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "/api/projects/p-1", { category_id: "pcat_sales" }],
      ["PATCH", "/api/projects/p-2", { category_id: "pcat_sales" }],
    ]);
    // Each request is its own idempotent write.
    expect(new Set(writes().map((c) => c.key)).size).toBe(2);
    // What went through is unticked, and the list re-reads.
    expect(screen.queryByText(/selected$/)).toBeNull();
    expect(calls.some((c) => c.method === "GET")).toBe(true);
  });

  it("moves to Uncategorized as category_id null, skipping ones already there", async () => {
    renderList([
      ITEM({ id: "a", slug: "a", name: "A", category_id: "pcat_sales" }),
      ITEM({ id: "b", slug: "b", name: "B", category_id: null }),
    ]);
    tick("A");
    tick("B");
    fireEvent.change(screen.getByRole("combobox", { name: "New category" }), {
      target: { value: "none" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply category" }));
    });
    await waitFor(() => expect(screen.getByText(/Moved 1 project to Uncategorized/)).toBeTruthy());
    expect(writes().map((c) => [c.url, c.body])).toEqual([
      ["/api/projects/a", { category_id: null }],
    ]);
  });

  it("archives after a confirm; a refused project is named and stays ticked", async () => {
    stubFetch({ "p-2": "This project has a run in progress." });
    renderList();
    tick("Project 1");
    tick("Project 2");
    fireEvent.click(screen.getByRole("button", { name: "Archive 2" }));
    // Nothing is sent until the confirm.
    expect(writes()).toEqual([]);
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2" }));
    });
    await waitFor(() => expect(screen.getByText(/Archived 1 project/)).toBeTruthy());
    expect(writes().map((c) => [c.method, c.url])).toEqual([
      ["POST", "/api/projects/p-1/archive"],
      ["POST", "/api/projects/p-2/archive"],
    ]);
    const result = screen.getByRole("status");
    expect(within(result).getByText(/Couldn.t archive 1 project/)).toBeTruthy();
    expect(within(result).getByText("Project 2")).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Restore, not Archive, for ticked archived projects", () => {
    renderList([
      ITEM({ id: "a", slug: "a", name: "A", archived: true, status: "archived" }),
    ]);
    tick("A");
    expect(screen.getByRole("button", { name: "Restore 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Archive \d/ })).toBeNull();
  });
});

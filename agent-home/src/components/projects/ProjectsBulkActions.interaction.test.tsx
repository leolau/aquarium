// @vitest-environment jsdom
/**
 * The `/projects` list's page numbers and bulk actions: ticking projects
 * (kept across pages, dropped on a new view), Set category and Archive
 * and Change state sending each project's own request, and a refusal staying ticked.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { ProjectsList } from "@/components/projects/ProjectsList";
import { SETTLE_MS } from "@/components/projects/ProjectsBulkBar";
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

function stubFetch(fail: Record<string, string> = {}, listed: ProjectListItem[] = MANY) {
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
      return new Response(JSON.stringify({ items: listed, next_cursor: null }), { status: 200 });
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

  const openStateMenu = (count: number) =>
    fireEvent.click(screen.getByRole("button", { name: `Change state (${count})` }));
  const menuItem = (move: string) => {
    const item = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .find((el) => el.getAttribute("data-move") === move);
    if (!item) throw new Error(`no ${move} item`);
    return item;
  };

  it("replaces the Archive button with a Change state (N) menu", () => {
    renderList();
    tick("Project 1");
    expect(screen.queryByRole("button", { name: /^Archive \d/ })).toBeNull();
    openStateMenu(1);
    const labels = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("data-move"));
    expect(labels).toEqual(["active", "paused", "done", "archive", "restore"]);
    // Project 1 is active and not archived.
    expect(menuItem("active").hasAttribute("disabled")).toBe(true);
    expect(menuItem("restore").hasAttribute("disabled")).toBe(true);
    expect(menuItem("paused").hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("pauses every ticked project with its own status PATCH, skipping ones already paused, and can undo", async () => {
    const three = [
      ITEM({ id: "a", slug: "a", name: "A", status: "active" }),
      ITEM({ id: "b", slug: "b", name: "B", status: "done" }),
      ITEM({ id: "c", slug: "c", name: "C", status: "paused" }),
    ];
    stubFetch({}, three);
    renderList(three);
    tick("A");
    tick("B");
    tick("C");
    openStateMenu(3);
    expect(menuItem("paused").textContent).toContain("2 of 3");
    await act(async () => {
      fireEvent.click(menuItem("paused"));
    });
    await waitFor(() => expect(screen.getByText(/Paused 2 projects/)).toBeTruthy());
    expect(screen.getByText(/1 project was already there/)).toBeTruthy();
    expect(writes().map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "/api/projects/a", { status: "paused" }],
      ["PATCH", "/api/projects/b", { status: "paused" }],
    ]);
    expect(new Set(writes().map((c) => c.key)).size).toBe(2);
    // What went through is unticked; the skipped one stays ticked.
    expect(screen.getByText("1 selected")).toBeTruthy();

    calls = [];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    await waitFor(() =>
      expect(screen.getByText(/Put back 2 projects to their previous state/)).toBeTruthy(),
    );
    expect(writes().map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "/api/projects/a", { status: "active" }],
      ["PATCH", "/api/projects/b", { status: "done" }],
    ]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("double-clicking Undo sends one undo, keeps the panel busy and never opens the row under it", async () => {
    const two = [
      ITEM({ id: "a", slug: "alpha", name: "Alpha", status: "active" }),
      ITEM({ id: "b", slug: "beta", name: "Beta", status: "active" }),
    ];
    stubFetch({ beta: "still has an open run" }, two);
    renderList(two);
    tick("Alpha");
    tick("Beta");
    openStateMenu(2);
    await act(async () => {
      fireEvent.click(menuItem("paused"));
    });
    await waitFor(() => expect(screen.getByText(/Paused 1 project/)).toBeTruthy());

    let release: () => void = () => {};
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null, key: null });
        if (method === "GET") {
          return new Response(JSON.stringify({ items: two, next_cursor: null }), { status: 200 });
        }
        await new Promise<void>((r) => (release = r));
        return new Response("{}", { status: 200 });
      }),
    );
    const row = screen.getByRole("link", { name: "Alpha" });
    const opened = vi.fn();
    row.addEventListener("click", opened);

    const undoButton = screen.getByRole("button", { name: "Undo" });
    act(() => {
      fireEvent.click(undoButton);
      fireEvent.click(undoButton);
    });
    // The panel stays where it was, busy, with the button locked.
    const panel = screen.getByRole("status");
    expect(panel.querySelector('[data-component="ProjectsBulkWorking"]')?.textContent).toMatch(/Undoing…/);
    const busyUndo = within(panel).getAllByRole("button").find((b) => b.getAttribute("aria-busy") === "true");
    expect(busyUndo?.hasAttribute("disabled")).toBe(true);
    // A stray click on the list underneath goes nowhere.
    expect(fireEvent.click(row)).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);

    await act(async () => release());
    await waitFor(() => expect(screen.getByText(/Put back 1 project/)).toBeTruthy());
    // Right after it lands the second click of a double-click is still swallowed…
    expect(fireEvent.click(row)).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    expect(writes().map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "/api/projects/alpha", { status: "active" }],
    ]);
    // …and the list is clickable again once things settle.
    await new Promise((r) => setTimeout(r, SETTLE_MS + 50));
    fireEvent.click(row);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("swallows a click on the list right after a confirmed archive", async () => {
    renderList();
    tick("Project 1");
    openStateMenu(1);
    fireEvent.click(menuItem("archive"));
    const row = screen.getByRole("link", { name: "Project 2" });
    const opened = vi.fn();
    row.addEventListener("click", opened);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    });
    await waitFor(() => expect(screen.getByText(/Archived 1 project/)).toBeTruthy());
    fireEvent.click(row);
    expect(opened).not.toHaveBeenCalled();
  });

  it("locks while applying: a second pick sends nothing more", async () => {
    let release: () => void = () => {};
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null, key: null });
        if (method === "GET") {
          return new Response(JSON.stringify({ items: MANY, next_cursor: null }), { status: 200 });
        }
        await new Promise<void>((r) => (release = r));
        return new Response("{}", { status: 200 });
      }),
    );
    renderList();
    tick("Project 1");
    openStateMenu(1);
    act(() => {
      fireEvent.click(menuItem("done"));
    });
    const trigger = await screen.findByRole("button", { name: /Working/ });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(writes()).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(screen.getByText(/Marked 1 project as Done/)).toBeTruthy());
    expect(writes().map((c) => [c.url, c.body])).toEqual([
      ["/api/projects/p-1", { status: "done" }],
    ]);
  });

  it("archives after a confirm; a refused project is named and stays ticked", async () => {
    stubFetch({ "p-2": "This project has a run in progress." });
    renderList();
    tick("Project 1");
    tick("Project 2");
    openStateMenu(2);
    fireEvent.click(menuItem("archive"));
    // Nothing is sent until the confirm, which explains what archive does.
    expect(writes()).toEqual([]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/stop running and move to the Archived view/)).toBeTruthy();
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
    // Archive keeps its own way back (the Archived view), not a status Undo.
    expect(within(result).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rides out a server restart: re-sends with the same key, then stops if it stays down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      calls = [];
      let down = 2; // the first two sends get no answer, then it is back
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({ url, method, body: null, key: headers["Idempotency-Key"] ?? null });
          if (method === "GET") {
            return new Response(JSON.stringify({ items: MANY, next_cursor: null }), { status: 200 });
          }
          if (down-- > 0) {
            return new Response(JSON.stringify({ error: "api_unreachable" }), { status: 502 });
          }
          return new Response("{}", { status: 200 });
        }),
      );
      renderList();
      tick("Project 1");
      tick("Project 2");
      fireEvent.change(screen.getByRole("combobox", { name: "New category" }), {
        target: { value: "pcat_sales" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply category" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await waitFor(() => expect(screen.getByText(/Moved 2 projects to Sales/)).toBeTruthy());
      const patches = writes();
      expect(patches.map((c) => c.url)).toEqual([
        "/api/projects/p-1",
        "/api/projects/p-1",
        "/api/projects/p-1",
        "/api/projects/p-2",
      ]);
      // Re-sends reuse the project's key, so a write that landed is not doubled.
      expect(new Set(patches.slice(0, 3).map((c) => c.key)).size).toBe(1);

      // Down for good: one project's retries run out, the rest is not sent.
      down = 1_000;
      calls = [];
      tick("Project 3");
      tick("Project 4");
      fireEvent.click(screen.getByRole("button", { name: "Apply category" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await waitFor(() =>
        expect(screen.getByText(/2 projects were\s+not changed/)).toBeTruthy(),
      );
      expect(new Set(writes().map((c) => c.url))).toEqual(new Set(["/api/projects/p-3"]));
      expect(screen.getByText("2 selected")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers only Restore for ticked archived projects, through the restore route", async () => {
    renderList([
      ITEM({ id: "a", slug: "a", name: "A", archived: true, status: "archived" }),
    ]);
    tick("A");
    openStateMenu(1);
    for (const move of ["active", "paused", "done", "archive"]) {
      expect(menuItem(move).hasAttribute("disabled")).toBe(true);
    }
    await act(async () => {
      fireEvent.click(menuItem("restore"));
    });
    await waitFor(() => expect(screen.getByText(/Restored 1 project as Paused/)).toBeTruthy());
    expect(writes().map((c) => [c.method, c.url])).toEqual([
      ["POST", "/api/projects/a/restore"],
    ]);
  });
});

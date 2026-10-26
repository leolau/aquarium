// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectsList } from "@/components/projects/ProjectsList";
import type { ProjectListItem } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("busy buttons — projects", () => {
  it("ProjectsList: a fast double click on Apply category sends each PATCH once", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((res) => {
          const body =
            init?.method === "PATCH" ? {} : { items: [], next_cursor: null };
          release = () => res(new Response(JSON.stringify(body), { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/projects?layout=list");
    const item = {
      id: "prj_1",
      slug: "monday-digest",
      name: "Send the Monday digest",
      category_id: null,
      archived: false,
      status: "active",
      cadence: "repeatable",
      progress: {
        rung: "cards",
        label: "cards",
        headline: "0 of 1 cards done",
        cards: { total: 1, done: 0, running: 0, blocked: 0 },
      },
    } as unknown as ProjectListItem;
    render(
      <ProjectsList
        initial={{ items: [item], next_cursor: null }}
        categories={[
          {
            id: "pcat_sales",
            name: "Sales",
            color: null,
            position: 0,
            created_at: 0,
            created_by: null,
            project_count: 0,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Send the Monday digest" }));
    fireEvent.change(screen.getByRole("combobox", { name: "New category" }), {
      target: { value: "pcat_sales" },
    });
    const button = screen.getByRole("button", { name: "Apply category" });
    fireEvent.click(button);
    fireEvent.click(button);
    const patches = () =>
      fetchMock.mock.calls.filter((c) => (c as unknown[])[1] && ((c as unknown[])[1] as RequestInit).method === "PATCH").length;
    expect(patches()).toBe(1);
    await act(async () => {
      release();
    });
    expect(patches()).toBe(1);
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });
});

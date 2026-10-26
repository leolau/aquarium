// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectsList } from "@/components/projects/ProjectsList";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("busy buttons — projects", () => {
  it("ProjectsList: a fast double click on Load more fetches the next page once", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((res) => {
          release = () =>
            res(new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/projects?layout=list");
    render(
      <ProjectsList initial={{ items: [], next_cursor: "cur_2" }} />,
    );
    const button = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(button);
    fireEvent.click(button);
    const pageCalls = () =>
      fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).includes("cur_2")).length;
    expect(pageCalls()).toBe(1);
    await act(async () => {
      release();
    });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });
});

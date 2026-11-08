// @vitest-environment jsdom
/**
 * Phones remember the Board/List pick in this browser: it applies when the
 * URL names no layout, a URL `layout` beats it, and desktop never saves it.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { ProjectsList } from "@/components/projects/ProjectsList";
import { EMPTY_FILTERS } from "@/components/projects/filters";

const KEY = "aquarium.projects.phoneLayout";

function renderList(props: { rememberLayout?: boolean; layoutInUrl?: boolean }) {
  return render(
    <ProjectsList
      initial={{ items: [], next_cursor: null }}
      initialFilters={{ ...EMPTY_FILTERS, layout: "list" }}
      {...props}
    />,
  );
}

const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/projects");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("ProjectsList — remembered phone layout", () => {
  it("saves the phone pick and reopens with it", () => {
    renderList({ rememberLayout: true });
    expect(pressed("List")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(window.localStorage.getItem(KEY)).toBe("board");
    cleanup();

    renderList({ rememberLayout: true });
    expect(pressed("Board")).toBe("true");
  });

  it("lets a URL layout beat the saved pick", () => {
    window.localStorage.setItem(KEY, "board");
    window.history.replaceState(null, "", "/projects?layout=list");
    renderList({ rememberLayout: true, layoutInUrl: true });
    expect(pressed("List")).toBe("true");
  });

  it("does not save the pick off phones", () => {
    renderList({});
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

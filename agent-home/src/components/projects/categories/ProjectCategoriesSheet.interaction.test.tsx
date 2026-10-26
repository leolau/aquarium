// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import {
  ProjectCategoriesSheet,
  projectsWillMove,
  reorderWrites,
} from "@/components/projects/categories/ProjectCategoriesSheet";
import {
  category,
  categoriesFetch,
  jsonResponse,
} from "@/components/projects/categories/testFixtures";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";

const SALES = category("pcat_sales", "Sales", 0, { color: "#ef4444", project_count: 3 });
const MARKETING = category("pcat_mkt", "Marketing", 1, { project_count: 1 });
const RESEARCH = category("pcat_res", "Research", 2);
const INITIAL = [SALES, MARKETING, RESEARCH];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(write?: Parameters<typeof categoriesFetch>[0]["write"], fresh = INITIAL) {
  const server = categoriesFetch({ list: () => fresh, write });
  vi.stubGlobal("fetch", server.fetchMock);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <ProjectCategoriesSheet categories={INITIAL} onClose={onClose} onChanged={onChanged} />,
  );
  return { ...server, onChanged, onClose, utils };
}

describe("ProjectCategoriesSheet", () => {
  it("lists the categories with their project counts, without re-reading on open", () => {
    const { utils, calls } = setup();
    expect(utils.getByText("Sales")).toBeTruthy();
    expect(utils.getByText("3 projects")).toBeTruthy();
    expect(utils.getByText("1 project")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("adds a category through useProjectAction, then hands the re-read list to onChanged", async () => {
    const ops = category("pcat_ops", "Operations", 3, { color: "#3b82f6" });
    const fresh = [...INITIAL, ops];
    const { utils, writes, calls, onChanged } = setup(() => jsonResponse(200, ops), fresh);
    fireEvent.change(utils.getByPlaceholderText("e.g. Sales"), { target: { value: "  Operations " } });
    fireEvent.click(utils.getByRole("button", { name: "Blue" }));
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Add category" }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(fresh));
    expect(writes()).toEqual([
      expect.objectContaining({
        url: "/api/project-categories",
        method: "POST",
        body: { name: "Operations", color: "#3b82f6" },
      }),
    ]);
    expect(writes()[0].headers[IDEMPOTENCY_HEADER]).toBeTruthy();
    const reread = calls[calls.length - 1];
    expect(reread).toMatchObject({ url: "/api/project-categories", method: "GET", cache: "no-store" });
    expect(utils.getByText("Operations")).toBeTruthy();
    expect((utils.getByPlaceholderText("e.g. Sales") as HTMLInputElement).value).toBe("");
  });

  it("refuses a blank name without a request", async () => {
    const { utils, calls } = setup();
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Add category" }));
    });
    expect(utils.getByText("A category needs a name.")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows a 409 duplicate inline and does not report a change", async () => {
    const { utils, onChanged } = setup(() =>
      jsonResponse(409, { detail: "category 'sales' already exists" }),
    );
    fireEvent.change(utils.getByPlaceholderText("e.g. Sales"), { target: { value: "sales" } });
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Add category" }));
    });
    expect((await utils.findByRole("alert")).textContent).toBe(
      "A category with that name already exists.",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("renames inline with a PATCH of just the name", async () => {
    const renamed = { ...SALES, name: "Revenue" };
    const fresh = [renamed, MARKETING, RESEARCH];
    const { utils, writes, onChanged } = setup(() => jsonResponse(200, renamed), fresh);
    fireEvent.click(utils.getByRole("button", { name: "Rename Sales" }));
    fireEvent.change(utils.getByLabelText("New name for Sales"), { target: { value: "Revenue" } });
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(fresh));
    expect(writes()).toEqual([
      expect.objectContaining({
        url: "/api/project-categories/pcat_sales",
        method: "PATCH",
        body: { name: "Revenue" },
      }),
    ]);
    expect(utils.getByText("Revenue")).toBeTruthy();
  });

  it("changes the name and the colour together from the rename form", async () => {
    const renamed = { ...SALES, name: "Revenue", color: "#3b82f6" };
    const fresh = [renamed, MARKETING, RESEARCH];
    const { utils, writes, onChanged } = setup(() => jsonResponse(200, renamed), fresh);
    fireEvent.click(utils.getByRole("button", { name: "Rename Sales" }));
    const row = utils.container.querySelector('[data-category-id="pcat_sales"]') as HTMLElement;
    // The form starts on the category's current colour.
    expect(within(row).getByRole("button", { name: "Red" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(utils.getByLabelText("New name for Sales"), { target: { value: "Revenue" } });
    fireEvent.click(within(row).getByRole("button", { name: "Blue" }));
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(fresh));
    expect(writes()).toEqual([
      expect.objectContaining({
        url: "/api/project-categories/pcat_sales",
        method: "PATCH",
        body: { name: "Revenue", color: "#3b82f6" },
      }),
    ]);
  });

  it("the rename form can change only the colour", async () => {
    const { utils, writes, onChanged } = setup(() => jsonResponse(200, MARKETING));
    fireEvent.click(utils.getByRole("button", { name: "Rename Marketing" }));
    const row = utils.container.querySelector('[data-category-id="pcat_mkt"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Teal" }));
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()).toEqual([
      expect.objectContaining({ method: "PATCH", body: { color: "#14b8a6" } }),
    ]);
  });

  it("recolours from the palette", async () => {
    const { utils, writes, onChanged } = setup(() => jsonResponse(200, MARKETING));
    fireEvent.click(utils.getByRole("button", { name: "Change colour of Marketing" }));
    await act(async () => {
      const row = utils.container.querySelector('[data-category-id="pcat_mkt"]') as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Green" }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes()).toEqual([
      expect.objectContaining({
        url: "/api/project-categories/pcat_mkt",
        method: "PATCH",
        body: { color: "#10b981" },
      }),
    ]);
  });

  it("deletes only after a confirm that says how many projects move", async () => {
    const fresh = [MARKETING, RESEARCH];
    const { utils, writes, onChanged } = setup(
      () => jsonResponse(200, { deleted: "pcat_sales", uncategorized: 3 }),
      fresh,
    );
    fireEvent.click(utils.getByRole("button", { name: "Delete Sales" }));
    expect(utils.getByText("3 projects will move to Uncategorized.")).toBeTruthy();
    expect(writes()).toHaveLength(0);
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Delete category" }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(fresh));
    expect(writes()).toEqual([
      expect.objectContaining({ url: "/api/project-categories/pcat_sales", method: "DELETE" }),
    ]);
    expect(utils.queryByText("3 projects will move to Uncategorized.")).toBeNull();
    expect(utils.queryByText("Sales")).toBeNull();
  });

  it("cancelling the delete confirm sends nothing", () => {
    const { utils, calls } = setup();
    fireEvent.click(utils.getByRole("button", { name: "Delete Sales" }));
    fireEvent.click(utils.getByRole("button", { name: "Cancel" }));
    expect(utils.queryByText(/will move to Uncategorized/)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("moves a category down by swapping positions", async () => {
    const { utils, writes, onChanged } = setup();
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Move Sales down" }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(writes().map((w) => [w.url, w.method, w.body])).toEqual([
      ["/api/project-categories/pcat_mkt", "PATCH", { position: 0 }],
      ["/api/project-categories/pcat_sales", "PATCH", { position: 1 }],
    ]);
  });

  it("never closes mid-write", async () => {
    let answer: (res: Response) => void = () => {};
    const { utils, onClose, onChanged } = setup(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    fireEvent.change(utils.getByPlaceholderText("e.g. Sales"), { target: { value: "Ops" } });
    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Add category" }));
    });
    const closeButton = utils.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(closeButton.disabled).toBe(true);
    fireEvent.click(utils.container.querySelector('[data-component="ProjectCategoriesSheet"]')!);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      answer(jsonResponse(200, category("pcat_ops", "Ops", 3)));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    fireEvent.click(utils.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("reorderWrites / projectsWillMove", () => {
  it("only re-sends the positions that change, counted from the lowest in use", () => {
    const a = category("a", "A", 4);
    const b = category("b", "B", 5);
    const c = category("c", "C", 6);
    expect(reorderWrites([a, b, c], [a, c, b]).map((w) => [w.path, w.body])).toEqual([
      ["/api/project-categories/c", { position: 5 }],
      ["/api/project-categories/b", { position: 6 }],
    ]);
  });

  it("renumbers tied positions", () => {
    const a = category("a", "A", 1);
    const b = category("b", "B", 1);
    expect(reorderWrites([a, b], [b, a]).map((w) => [w.path, w.body])).toEqual([
      ["/api/project-categories/a", { position: 2 }],
    ]);
  });

  it("pluralises the move sentence", () => {
    expect(projectsWillMove(1)).toBe("1 project will move to Uncategorized.");
    expect(projectsWillMove(0)).toBe("0 projects will move to Uncategorized.");
  });
});

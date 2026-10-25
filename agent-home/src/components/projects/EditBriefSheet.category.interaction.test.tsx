// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { EditBriefSheet, briefPatch } from "@/components/projects/EditBriefSheet";
import {
  category,
  categoriesFetch,
  jsonResponse,
} from "@/components/projects/categories/testFixtures";
import type { ProjectDetail } from "@/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIST = [category("pcat_sales", "Sales", 0), category("pcat_mkt", "Marketing", 1)];

const BRIEF = { name: "Digest", goal: "Ship it", description: "", target_audience: "" };

describe("briefPatch — category_id", () => {
  it("sends category_id only when it changed", () => {
    expect(
      briefPatch({ ...BRIEF, category_id: "pcat_sales" }, { ...BRIEF, category_id: "pcat_mkt" }),
    ).toEqual({ category_id: "pcat_mkt" });
    expect(
      briefPatch({ ...BRIEF, category_id: "pcat_sales" }, { ...BRIEF, category_id: "pcat_sales" }),
    ).toEqual({});
    expect(briefPatch({ ...BRIEF, category_id: null }, { ...BRIEF, category_id: null })).toEqual({});
  });

  it("clearing sends null", () => {
    expect(
      briefPatch({ ...BRIEF, category_id: "pcat_sales" }, { ...BRIEF, category_id: null }),
    ).toEqual({ category_id: null });
  });

  it("text fields still diff trimmed, as before", () => {
    expect(briefPatch(BRIEF, { ...BRIEF, goal: " Ship it " })).toEqual({});
    expect(briefPatch(BRIEF, { ...BRIEF, goal: " New goal " })).toEqual({ goal: "New goal" });
  });
});

function project(category_id: string | null): ProjectDetail {
  return {
    slug: "digest",
    name: "Digest",
    goal: "Ship it",
    description: "",
    target_audience: "",
    status: "active",
    category_id,
  } as unknown as ProjectDetail;
}

async function renderSheet(category_id: string | null) {
  const server = categoriesFetch({
    list: () => LIST,
    write: (call) => jsonResponse(200, { slug: "digest", ...(call.body as object) }),
  });
  vi.stubGlobal("fetch", server.fetchMock);
  const onClose = vi.fn();
  const utils = render(<EditBriefSheet project={project(category_id)} onClose={onClose} />);
  const select = utils.getByLabelText("Category") as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  return { ...server, utils, onClose, select };
}

async function save(utils: ReturnType<typeof render>) {
  await act(async () => {
    fireEvent.click(utils.getByRole("button", { name: "Save" }));
  });
}

describe("EditBriefSheet — category", () => {
  it("PATCHes the new category when it changed", async () => {
    const { utils, writes, onClose, select } = await renderSheet("pcat_sales");
    expect(select.value).toBe("pcat_sales");
    fireEvent.change(select, { target: { value: "pcat_mkt" } });
    await save(utils);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writes()).toEqual([
      expect.objectContaining({
        url: "/api/projects/digest",
        method: "PATCH",
        body: { category_id: "pcat_mkt" },
      }),
    ]);
  });

  it("leaves category_id out when only the goal changed", async () => {
    const { utils, writes, onClose } = await renderSheet("pcat_sales");
    fireEvent.change(utils.getByDisplayValue("Ship it"), { target: { value: "Ship it today" } });
    await save(utils);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writes().map((w) => w.body)).toEqual([{ goal: "Ship it today" }]);
  });

  it("sends nothing when nothing changed", async () => {
    const { utils, writes, onClose } = await renderSheet("pcat_sales");
    await save(utils);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(0);
  });

  it("clearing to Uncategorized sends null", async () => {
    const { utils, writes, onClose, select } = await renderSheet("pcat_sales");
    fireEvent.change(select, { target: { value: "" } });
    await save(utils);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writes().map((w) => w.body)).toEqual([{ category_id: null }]);
  });
});

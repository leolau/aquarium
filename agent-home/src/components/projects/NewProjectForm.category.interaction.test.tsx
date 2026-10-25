// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { NewProjectForm } from "@/components/projects/NewProjectForm";
import {
  category,
  categoriesFetch,
  jsonResponse,
} from "@/components/projects/categories/testFixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockClear();
});

const LIST = [category("pcat_sales", "Sales", 0), category("pcat_mkt", "Marketing", 1)];

async function createWith(pick: string | null) {
  const server = categoriesFetch({
    list: () => LIST,
    write: (call) =>
      call.url === "/api/projects"
        ? jsonResponse(200, { slug: "monday-digest" })
        : jsonResponse(200, {}),
    read: () => ({ rows: [], total: 0, limit: 6, offset: 0 }),
  });
  vi.stubGlobal("fetch", server.fetchMock);
  const utils = render(<NewProjectForm servingProfile="default" />);
  const select = utils.getByLabelText("Category (optional)") as HTMLSelectElement;
  await waitFor(() => expect(select.options).toHaveLength(3));
  if (pick) fireEvent.change(select, { target: { value: pick } });
  fireEvent.change(utils.getByPlaceholderText("Ship the Monday digest to every subscriber"), {
    target: { value: "The team starts Monday briefed" },
  });
  fireEvent.change(
    utils.getByPlaceholderText("A weekly digest compiled from arrivals and emailed each Monday…"),
    { target: { value: "A weekly digest." } },
  );
  fireEvent.change(utils.getByPlaceholderText("The Monday digest email"), {
    target: { value: "The Monday digest email" },
  });
  fireEvent.click(utils.getByText("Next: inputs"));
  fireEvent.click(utils.getByText("I have no inputs — skip"));
  fireEvent.click(utils.getByText("Next: review"));
  if (pick) expect(utils.getByText(LIST.find((c) => c.id === pick)!.name)).toBeTruthy();
  await act(async () => {
    fireEvent.click(utils.getByText("Create project and answer a few questions"));
  });
  await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
  const creates = server.calls.filter((c) => c.url === "/api/projects");
  expect(creates).toHaveLength(1);
  return creates[0].body as Record<string, unknown>;
}

describe("NewProjectForm — category", () => {
  it("sends the chosen category_id in the create payload", async () => {
    const body = await createWith("pcat_mkt");
    expect(body.category_id).toBe("pcat_mkt");
    expect(body.goal).toBe("The team starts Monday briefed");
  });

  it("omits category_id when none is chosen", async () => {
    const body = await createWith(null);
    expect("category_id" in body).toBe(false);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CategoryPicker } from "@/components/projects/categories/CategoryPicker";
import { category, categoriesFetch, jsonResponse } from "@/components/projects/categories/testFixtures";
import { useProjectCategories } from "@/components/projects/categories/useProjectCategories";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIST = [
  category("pcat_r", "Research", 2),
  category("pcat_s", "Sales", 0, { color: "#ef4444" }),
  category("pcat_m", "Marketing", 1),
];

describe("CategoryPicker", () => {
  it("is labelled and lists Uncategorized then the categories in position order", () => {
    const utils = render(
      <CategoryPicker categories={LIST} value={null} onChange={() => {}} id="cat" />,
    );
    const select = utils.getByLabelText("Category") as HTMLSelectElement;
    expect(select.id).toBe("cat");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Uncategorized",
      "Sales",
      "Marketing",
      "Research",
    ]);
    expect(select.value).toBe("");
    const sales = Array.from(select.options).find((o) => o.value === "pcat_s")!;
    expect(sales.style.color).toBe("rgb(239, 68, 68)");
  });

  it("reports an id, and null for Uncategorized", () => {
    const onChange = vi.fn();
    const utils = render(<CategoryPicker categories={LIST} value="pcat_m" onChange={onChange} />);
    const select = utils.getByLabelText("Category");
    fireEvent.change(select, { target: { value: "pcat_r" } });
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange.mock.calls).toEqual([["pcat_r"], [null]]);
  });

  it("keeps an unknown id selected instead of showing another category", () => {
    const utils = render(<CategoryPicker categories={LIST} value="pcat_gone" onChange={() => {}} />);
    const select = utils.getByLabelText("Category") as HTMLSelectElement;
    expect(select.value).toBe("pcat_gone");
    expect(select.selectedOptions[0].textContent).toBe("Unknown category");
  });

  it("can be disabled", () => {
    const utils = render(<CategoryPicker categories={LIST} value={null} onChange={() => {}} disabled />);
    expect((utils.getByLabelText("Category") as HTMLSelectElement).disabled).toBe(true);
  });
});

function Probe() {
  const state = useProjectCategories();
  return (
    <div>
      <span data-testid="loading">{String(state.loading)}</span>
      <span data-testid="error">{state.error ?? ""}</span>
      <span data-testid="names">{state.categories.map((c) => c.name).join(",")}</span>
      <button onClick={() => void state.reload()}>reload</button>
    </div>
  );
}

describe("useProjectCategories", () => {
  it("reads once on mount, uncached, in column order", async () => {
    const server = categoriesFetch({ list: () => LIST });
    vi.stubGlobal("fetch", server.fetchMock);
    const utils = render(<Probe />);
    expect(utils.getByTestId("loading").textContent).toBe("true");
    await waitFor(() => expect(utils.getByTestId("loading").textContent).toBe("false"));
    expect(utils.getByTestId("names").textContent).toBe("Sales,Marketing,Research");
    expect(server.calls).toEqual([
      expect.objectContaining({ url: "/api/project-categories", method: "GET", cache: "no-store" }),
    ]);
  });

  it("surfaces a failed read and recovers on reload", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail ? jsonResponse(500, {}) : jsonResponse(200, { items: LIST.slice(0, 1) }),
      ),
    );
    const utils = render(<Probe />);
    await waitFor(() => expect(utils.getByTestId("error").textContent).not.toBe(""));
    fail = false;
    fireEvent.click(utils.getByText("reload"));
    await waitFor(() => expect(utils.getByTestId("names").textContent).toBe("Research"));
    expect(utils.getByTestId("error").textContent).toBe("");
  });
});

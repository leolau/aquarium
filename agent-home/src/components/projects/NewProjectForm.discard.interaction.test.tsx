// @vitest-environment jsdom
/**
 * Leaving the wizard with unsaved answers asks first: Keep editing stays,
 * Discard navigates. A pristine wizard leaves without a question.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/new",
  useRouter: () => router,
}));

import { NewProjectForm } from "@/components/projects/NewProjectForm";
import { categoriesFetch, jsonResponse } from "@/components/projects/categories/testFixtures";

beforeEach(() => {
  const server = categoriesFetch({
    list: () => [],
    write: () => jsonResponse(200, {}),
    read: () => ({ rows: [], total: 0, limit: 6, offset: 0 }),
  });
  vi.stubGlobal("fetch", server.fetchMock);
  window.history.replaceState(null, "", "/projects/new");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockClear();
});

function renderWizard() {
  return render(
    <>
      {/* A plain anchor stands in for the shell Back link (next/link needs the app router). */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/projects">Projects</a>
      <NewProjectForm servingProfile="default" />
    </>,
  );
}

describe("NewProjectForm — discard changes", () => {
  it("asks before leaving with unsaved answers", async () => {
    const utils = renderWizard();
    fireEvent.change(utils.getByPlaceholderText("Ship the Monday digest to every subscriber"), {
      target: { value: "Brief the team" },
    });

    fireEvent.click(utils.getByText("Projects"));
    expect(utils.getByText("Discard this new project?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(utils.getByText("Keep editing"));
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(utils.queryByText("Discard this new project?")).toBeNull();

    fireEvent.click(utils.getByText("Projects"));
    await act(async () => {
      fireEvent.click(utils.getByText("Discard"));
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/projects"));
  });

  it("leaves a pristine wizard without asking", () => {
    const utils = renderWizard();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    utils.getByText("Projects").dispatchEvent(event);
    expect(utils.queryByText("Discard this new project?")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps the step buttons in a sticky footer", () => {
    const utils = renderWizard();
    const footer = utils.container.querySelector('[data-component="WizardFooter"]');
    expect(footer?.className).toContain("sticky");
    expect(footer?.textContent).toContain("Next: inputs");
  });
});

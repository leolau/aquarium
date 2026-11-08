// @vitest-environment jsdom
/** The card page links back to its project, named when the project loads. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectCardMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/draft-a-new-quotation/cards/task_1",
  useRouter: () => ({ refresh: () => {}, push: () => {}, back: () => {} }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async () => ({ userId: "leo" }),
  apiClientForRequest: async () => ({
    projectCard: projectCardMock,
    project: projectMock,
  }),
}));

vi.mock("@/components/MobileShell", () => ({
  // The shell's PageHeader owns Back; record what the page hands it.
  MobileShell: ({
    children,
    title,
    labels,
  }: {
    children: React.ReactNode;
    title: string;
    labels?: Record<string, string>;
  }) => (
    <div data-testid="shell" data-title={title} data-labels={JSON.stringify(labels ?? null)}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/projects/CardDetailView", () => ({
  CardDetailView: () => <div data-component="CardDetailView" />,
}));

import Page from "./page";

const params = Promise.resolve({
  slug: "draft-a-new-quotation",
  id: "t_700dc12b",
});

afterEach(() => {
  cleanup();
  projectCardMock.mockReset();
  projectMock.mockReset();
});

describe("card page", () => {
  it("names the parent project for the shell's Back", async () => {
    projectCardMock.mockResolvedValue({
      id: "t_700dc12b",
      title: "Present the draft",
    });
    projectMock.mockResolvedValue({
      name: "Draft a new quotation",
      archived: false,
      profiles: [],
    });
    const { getByTestId } = render(await Page({ params }));
    // The shell's Back / breadcrumb names the parent project.
    expect(JSON.parse(getByTestId("shell").getAttribute("data-labels")!)).toEqual({
      "/projects/draft-a-new-quotation": "Draft a new quotation",
    });
  });

  it("falls back to the default label when the card can't load", async () => {
    projectCardMock.mockRejectedValue(new Error("down"));
    const { container, getByTestId } = render(await Page({ params }));
    // No name to show: the shell falls back to its own "Project" label.
    expect(getByTestId("shell").getAttribute("data-labels")).toBe("null");
    expect(container.querySelector('[data-component="CardPageError"] [data-component="ErrorState"]')).toBeTruthy();
  });
});

// @vitest-environment jsdom
/** The card page links back to its project, named when the project loads. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectCardMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
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
  MobileShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
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
  it("links back to the project by name", async () => {
    projectCardMock.mockResolvedValue({
      id: "t_700dc12b",
      title: "Present the draft",
    });
    projectMock.mockResolvedValue({
      name: "Draft a new quotation",
      archived: false,
      profiles: [],
    });
    const { getByRole } = render(await Page({ params }));
    const back = getByRole("link", { name: "← Back to Draft a new quotation" });
    expect(back.getAttribute("href")).toBe("/projects/draft-a-new-quotation");
  });

  it("still links back when the project or the card can't load", async () => {
    projectCardMock.mockRejectedValue(new Error("down"));
    const { getByRole } = render(await Page({ params }));
    const back = getByRole("link", { name: "← Back to project" });
    expect(back.getAttribute("href")).toBe("/projects/draft-a-new-quotation");
  });
});

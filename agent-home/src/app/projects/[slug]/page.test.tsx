// @vitest-environment jsdom
/** The project page links back to the projects list, loaded or not. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectMock = vi.hoisted(() => vi.fn());
const fanOut = vi.hoisted(() => () => Promise.reject(new Error("unused")));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async () => ({ user_id: "leo", role: "owner" }),
  apiClientForRequest: async () => ({
    project: projectMock,
    projectBoard: fanOut,
    projectPlaybook: fanOut,
    projectDirectives: fanOut,
    projectDoctor: fanOut,
  }),
}));

vi.mock("@/components/MobileShell", () => ({
  MobileShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// The detail view has its own tests; only the page's chrome is under test.
vi.mock("@/components/projects/ProjectDetailView", () => ({
  ProjectDetailView: () => <div data-testid="detail" />,
}));

import Page from "./page";

const PARAMS = Promise.resolve({ slug: "aws-ec2-instance-health-check" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the project page's way back", () => {
  it("links to the projects list above the project", async () => {
    projectMock.mockResolvedValue({ name: "AWS EC2 instance health check" });
    const { getByRole, getByTestId } = render(await Page({ params: PARAMS }));
    expect(getByRole("link", { name: "← Projects" }).getAttribute("href")).toBe(
      "/projects",
    );
    expect(getByTestId("detail")).toBeTruthy();
  });

  it("still links back when the project couldn't load", async () => {
    projectMock.mockRejectedValue(new Error("down"));
    const { getByRole, getByText } = render(await Page({ params: PARAMS }));
    expect(getByRole("link", { name: "← Projects" }).getAttribute("href")).toBe(
      "/projects",
    );
    expect(getByText(/Couldn.t load this project/)).toBeTruthy();
  });
});

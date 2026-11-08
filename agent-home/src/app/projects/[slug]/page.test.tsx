// @vitest-environment jsdom
/** The project page: Back comes from the shell; a one-off opens as its Task view. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectMock = vi.hoisted(() => vi.fn());
const fanOut = vi.hoisted(() => () => Promise.reject(new Error("unused")));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {}, back: () => {} }),
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

// The detail view has its own tests; only the page's chrome is under test.
const viewContext = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ device: string; mode: string }>>(async () => ({
    device: "desktop",
    mode: "project",
  })),
);
vi.mock("@/components/projects/task/viewModeServer", () => ({
  projectViewContext: viewContext,
}));
vi.mock("@/components/projects/ProjectDetailView", () => ({
  ProjectDetailView: () => <div data-testid="detail" />,
}));

import Page from "./page";

const PARAMS = Promise.resolve({ slug: "aws-ec2-instance-health-check" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the project page", () => {
  it("titles the shell with the project and leaves Back to the shell", async () => {
    projectMock.mockResolvedValue({ name: "AWS EC2 instance health check", cadence: "standing" });
    const { getByTestId, queryByRole } = render(await Page({ params: PARAMS }));
    expect(getByTestId("shell").getAttribute("data-title")).toBe("AWS EC2 instance health check");
    expect(queryByRole("link", { name: "← Projects" })).toBeNull();
    expect(getByTestId("detail")).toBeTruthy();
    expect(viewContext.mock.calls[0][1]).toBeUndefined();
  });

  it("opens a one-off as its Task view unless the URL names a tab or view", async () => {
    projectMock.mockResolvedValue({ name: "Quote", cadence: "one_off" });
    render(await Page({ params: PARAMS }));
    expect(viewContext.mock.calls.at(-1)?.[1]).toBe("task");
    cleanup();
    render(await Page({ params: PARAMS, searchParams: Promise.resolve({ view: "project" }) }));
    expect(viewContext.mock.calls.at(-1)?.[1]).toBe("project");
    cleanup();
    render(await Page({ params: PARAMS, searchParams: Promise.resolve({ tab: "work" }) }));
    expect(viewContext.mock.calls.at(-1)?.[1]).toBe("project");
  });

  it("shows the friendly error when the project couldn't load", async () => {
    projectMock.mockRejectedValue(new Error("down"));
    const { container, getByText } = render(await Page({ params: PARAMS }));
    expect(container.querySelector('[data-component="ProjectPageError"] [data-component="ErrorState"]')).toBeTruthy();
    expect(getByText(/Couldn.t load this project/)).toBeTruthy();
  });
});

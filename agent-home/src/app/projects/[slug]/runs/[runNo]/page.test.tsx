// @vitest-environment jsdom
/**
 * The run page's own loader (U11): it fetches the project alongside the
 * run purely to carry the `archived` flag — and a *failed* project fetch
 * renders the run unflagged rather than erroring the page (the deliberate
 * choice in #310's step 3; the router refuses the writes anyway).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const projectRunMock = vi.hoisted(() => vi.fn());
const projectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async () => ({ userId: "leo" }),
  apiClientForRequest: async () => ({
    projectRun: projectRunMock,
    project: projectMock,
  }),
}));

// The shell's navs are irrelevant to the loader under test.
vi.mock("@/components/MobileShell", () => ({
  MobileShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import Page from "./page";
import { HermesApiError } from "@/lib/api/client";
import type { ProjectRun } from "@/types";

const NOW = Math.floor(Date.now() / 1000);

const RUN: ProjectRun = {
  id: "run_1",
  project_id: "prj_1",
  run_no: 1,
  trigger: "manual",
  triggered_by: "leo",
  profile: "default",
  playbook_rev: 1,
  status: "waiting",
  started_at: NOW - 3600,
  ended_at: null,
  session_id: null,
  trace_id: null,
  outcome: null,
  summary: null,
  retro: null,
  retro_at: null,
  score_self: null,
  score_user: null,
  score_note: null,
  scored_by: null,
  scored_at: null,
  error: null,
  cards: [],
  deliveries: [],
};

const PARAMS = Promise.resolve({ slug: "monday-digest", runNo: "1" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the run page's project fetch", () => {
  it("flags the run when the project is archived", async () => {
    projectRunMock.mockResolvedValue(RUN);
    projectMock.mockResolvedValue({ archived: true });
    const { getByRole, getByText } = render(await Page({ params: PARAMS }));
    expect(getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(getByText(/This project is archived/)).toBeTruthy();
  });

  it("keeps every write on a live project", async () => {
    projectRunMock.mockResolvedValue(RUN);
    projectMock.mockResolvedValue({ archived: false });
    const { getByRole, queryByText } = render(await Page({ params: PARAMS }));
    expect(getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(queryByText(/This project is archived/)).toBeNull();
  });

  it("renders the run unflagged when the project fetch fails", async () => {
    projectRunMock.mockResolvedValue(RUN);
    projectMock.mockRejectedValue(new HermesApiError(500, "upstream blew up"));
    const { getByRole, queryByText } = render(await Page({ params: PARAMS }));
    // Unflagged — NOT an error page: the run is the page.
    expect(getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(queryByText(/This project is archived/)).toBeNull();
    expect(queryByText(/Couldn't load run/)).toBeNull();
  });

  it("links back to its project, by name", async () => {
    projectRunMock.mockResolvedValue(RUN);
    projectMock.mockResolvedValue({ archived: false, name: "Monday digest" });
    const { getByRole } = render(await Page({ params: PARAMS }));
    const back = getByRole("link", { name: "← Back to Monday digest" });
    expect(back.getAttribute("href")).toBe("/projects/monday-digest");
  });

  it("still links back when the project fetch fails", async () => {
    projectRunMock.mockResolvedValue(RUN);
    projectMock.mockRejectedValue(new HermesApiError(500, "upstream blew up"));
    const { getByRole } = render(await Page({ params: PARAMS }));
    const back = getByRole("link", { name: "← Back to project" });
    expect(back.getAttribute("href")).toBe("/projects/monday-digest");
  });

  it("404s when the run itself is missing", async () => {
    projectRunMock.mockRejectedValue(new HermesApiError(404, "no such run"));
    projectMock.mockResolvedValue({ archived: false });
    await expect(Page({ params: PARAMS })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

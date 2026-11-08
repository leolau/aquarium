// @vitest-environment jsdom
/**
 * Handler-level tests for the lifecycle menu (U4): archive/restore/delete
 * actually call the route and refresh, refusals surface their upstream
 * wording with the typed input surviving, and Delete stays disabled until
 * the slug matches.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => router,
}));

import { ProjectLifecycleMenu } from "@/components/projects/ProjectLifecycleMenu";
import type { ProjectDetail } from "@/types";

const NOW = Math.floor(Date.now() / 1000);

const PROJECT = (over: Partial<ProjectDetail>): ProjectDetail => ({
  id: "prj_1",
  slug: "monday-digest",
  name: "Send the Monday digest",
  description: "The digest the team reads before standup.",
  icon: null,
  color: null,
  board_slug: "monday",
  primary_path: null,
  archived: false,
  created_at: NOW - 30 * 86_400,
  goal: "The team starts Monday already briefed",
  visibility: "shared",
  owner_user_id: "leo_owner",
  status: "active",
  cadence: "repeatable",
  schedule: "every monday 09:00",
  review_every: null,
  autonomy: "supervised",
  max_in_progress: 1,
  budget_usd_per_run: null,
  definition_of_done: null,
  target_audience: "the platform team",
  score_rubric: null,
  toolsets: "web,file",
  skills: "digest-writer",
  due_at: null,
  host_profile: "default",
  cron_job_id: null,
  summary: null,
  summary_at: null,
  last_reviewed_at: null,
  next_run_at: null,
  outputs: [],
  members: [
    { project_id: "prj_1", user_id: "leo_owner", role: "lead", added_by: null, added_at: NOW },
  ],
  profiles: [],
  contacts: [],
  links: {},
  progress: {
    rung: "outputs",
    label: "outputs",
    headline: "0 of 1 outputs accepted",
    accepted: 0,
    required: 1,
    cards: { total: 0, done: 0, running: 0, blocked: 0 },
  },
  score: null,
  health: "ok",
  runs: [],
  card_rollup: { total: 0, done: 0, running: 0, blocked: 0 },
  recent_events: [],
  ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openMenu(getByLabelText: (l: string) => HTMLElement) {
  fireEvent.click(getByLabelText("Project actions"));
}

describe("ProjectLifecycleMenu handlers", () => {
  it("archives through the route and refreshes the server read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { slug: "monday-digest", archived: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, getByText, getByPlaceholderText } = render(
      <ProjectLifecycleMenu
        project={PROJECT({})}
        callerUserId="leo_owner"
        isInstanceAdmin={false}
      />,
    );
    openMenu(getByLabelText);
    fireEvent.click(getByText("Archive project…"));
    fireEvent.change(getByPlaceholderText("Done for the term"), {
      target: { value: "Winding down for the break" },
    });
    fireEvent.click(getByText("Archive"));

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/projects/monday-digest/archive");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      reason: "Winding down for the break",
    });
  });

  it("surfaces an archive refusal and keeps the typed reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        error: "api_error",
        detail: "refused: needs_completion — goal is blank",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, getByText, getByPlaceholderText, findByRole } = render(
      <ProjectLifecycleMenu
        project={PROJECT({})}
        callerUserId="leo_owner"
        isInstanceAdmin={false}
      />,
    );
    openMenu(getByLabelText);
    fireEvent.click(getByText("Archive project…"));
    fireEvent.change(getByPlaceholderText("Done for the term"), {
      target: { value: "Winding down for the break" },
    });
    fireEvent.click(getByText("Archive"));

    const alert = await findByRole("alert");
    expect(alert.textContent).toBe("refused: needs_completion — goal is blank");
    expect((getByPlaceholderText("Done for the term") as HTMLInputElement).value).toBe(
      "Winding down for the break",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("restores a shelved project through the route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { slug: "monday-digest", status: "paused" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, getByText } = render(
      <ProjectLifecycleMenu
        project={PROJECT({ archived: true, status: "archived" })}
        callerUserId="leo_owner"
        isInstanceAdmin={false}
      />,
    );
    openMenu(getByLabelText);
    fireEvent.click(getByText("Restore project"));

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/projects/monday-digest/restore");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("keeps Delete disabled until the typed slug matches, then deletes and leaves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { deleted: "monday-digest" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, getByText, getByRole } = render(
      <ProjectLifecycleMenu
        project={PROJECT({ archived: true, status: "archived" })}
        callerUserId="leo_owner"
        isInstanceAdmin={false}
      />,
    );
    openMenu(getByLabelText);
    fireEvent.click(getByText("Delete permanently…"));

    const confirmButton = getByRole("button", { name: "Delete forever" });
    expect(confirmButton).toHaveProperty("disabled", true);
    const input = getByLabelText(/to confirm/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "monday-digest" } });
    expect(confirmButton).toHaveProperty("disabled", false);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/projects"));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/projects/monday-digest?confirm=monday-digest",
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});

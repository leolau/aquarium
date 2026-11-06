// @vitest-environment jsdom
/**
 * Task mode's home: Start task posts one quick-task request carrying the
 * check-in level as autonomy, chips prefill the box, failed tasks offer
 * Retry, and a viewer sees the lists but no Start box.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import type { ProjectListItem } from "@/types";

import { SUGGESTIONS, TaskHome } from "./TaskHome";
import { item } from "./taskFixtures";

const PROFILES = [
  { name: "default", is_default: true, description: "" },
  { name: "research", is_default: false, description: "" },
];

function mockFetch(body: unknown = { slug: "new-task" }) {
  const fn = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function home(items: ProjectListItem[] = [], canStart = true, device: "desktop" | "phone" = "desktop") {
  return render(
    <TaskHome
      items={items}
      profiles={PROFILES}
      defaultProfile="default"
      canStart={canStart}
      device={device}
      onShowProjects={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockReset();
});

describe("TaskHome", () => {
  it("starts a task with the picked profile and check-in level, then opens it", async () => {
    const fetchFn = mockFetch();
    home();
    fireEvent.change(screen.getByPlaceholderText("What should the agent do?"), {
      target: { value: "Summarise Q3 sales" },
    });
    fireEvent.change(screen.getByLabelText("Profile"), { target: { value: "research" } });
    fireEvent.change(screen.getByLabelText("Check in with me"), { target: { value: "autonomous" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/projects/new-task"));
    const [path, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/projects/quick-task");
    expect(JSON.parse(String(init.body))).toEqual({
      request: "Summarise Q3 sales",
      host_profile: "research",
      autonomy: "autonomous",
      check_plan_first: false,
    });
  });

  it("defaults to checking in before risky steps and can pause for the plan", async () => {
    const fetchFn = mockFetch();
    home();
    fireEvent.click(screen.getByRole("button", { name: SUGGESTIONS[0] }));
    expect(screen.getByPlaceholderText("What should the agent do?")).toHaveProperty("value", SUGGESTIONS[0]);
    fireEvent.click(screen.getByLabelText("Let me check the plan first"));
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.autonomy).toBe("supervised");
    expect(body.check_plan_first).toBe(true);
  });

  it("gives a viewer the lists but no Start box", () => {
    home([item({ slug: "a", name: "Visible task" })], false);
    expect(screen.queryByPlaceholderText("What should the agent do?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start task" })).toBeNull();
    expect(screen.getByText("Visible task")).toBeTruthy();
  });

  it("lists only what the server returned, as tasks, and notes the projects left out", () => {
    home([
      item({ slug: "a", name: "One-off" }),
      item({ slug: "b", name: "Weekly digest", cadence: "repeatable" }),
    ]);
    expect(screen.getByText("One-off")).toBeTruthy();
    expect(screen.queryByText("Weekly digest")).toBeNull();
    expect(screen.getByText(/1 repeating or standing project stays in Project mode/)).toBeTruthy();
  });

  it("retries a failed task through the quick-task start route", async () => {
    const fetchFn = mockFetch({ status: "drafting" });
    home([item({ slug: "broken", name: "Broken", latest_run: { run_no: 1, status: "failed" } })]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe("/api/projects/broken/quick-task/start");
  });

  it("hides Retry from a viewer", () => {
    home([item({ slug: "broken", latest_run: { run_no: 1, status: "failed" } })], false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("pins the ask box below the lists on a phone", () => {
    const { container } = home([item({ slug: "a" })], true, "phone");
    const box = container.querySelector('[data-component="TaskAskBox"]');
    const section = container.querySelector('[data-component="TaskSection"]');
    expect(box?.className).toContain("sticky");
    expect(section!.compareDocumentPosition(box!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

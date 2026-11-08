// @vitest-environment jsdom
/**
 * FG-34: the plan says who does each step and why, the step editor's
 * assignee picker explains each profile, and a hand-picked assignee is
 * saved as the person's choice.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => router,
}));

import { CardDetailView } from "@/components/projects/CardDetailView";
import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import type { AssignableProfile, PlaybookRev, ProjectCardDetail } from "@/types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ROSTER: AssignableProfile[] = [
  {
    name: "default",
    description: "General helper.",
    skills: [{ name: "notes" }],
    track_record: { window_days: 90, completed: 3, blocked: 0, failed: 1 },
    in_project: true,
    is_host: true,
  },
  {
    name: "researcher",
    description: "Finds and cites sources.",
    skills: [{ name: "web-research" }, { name: "citation" }],
    track_record: { window_days: 90, completed: 14, blocked: 1, failed: 0 },
    in_project: false,
    is_host: false,
  },
  { name: "writer", description: "", skills: [], in_project: true, is_host: false },
];

const ROSTER_URL = "/api/projects/monday-digest/assignable-profiles";
const SAVE_URL = "/api/projects/monday-digest/playbook";

function server(roster: AssignableProfile[] | null = ROSTER) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url === ROSTER_URL) {
      return Promise.resolve(roster ? jsonResponse(200, { profiles: roster }) : jsonResponse(404, {}));
    }
    if (url === SAVE_URL && init?.method === "POST") {
      return Promise.resolve(jsonResponse(200, { rev: 4, active: false }));
    }
    return Promise.resolve(jsonResponse(200, { status: "idle" }));
  });
}

const REV: PlaybookRev = {
  project_id: "prj_1",
  rev: 3,
  body: "",
  steps: [
    {
      key: "collect",
      title: "Collect pricing",
      assignee: "default",
      assignee_reason: "Has notes; the host by default.",
      fit: "partial",
      matched_skills: ["notes"],
      assigned_by: "planner",
    },
    { key: "draft", title: "Draft report", assignee: "writer", fit: "strong", assigned_by: "planner", assignee_reason: "Writes reports." },
    { key: "send", title: "Email client", assignee: null, fit: "none", assigned_by: "fallback", suggested_profile: "mailer" },
  ],
  active: 1,
  created_by: "leo",
  created_at: 1,
  activated_at: 2,
  note: null,
};

const PROPS = {
  slug: "monday-digest",
  profiles: ["default", "writer"],
  hostProfile: "default",
  canActivate: true,
  archived: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

describe("PlanPanel — who does what", () => {
  it("summarises profiles, explains each step and warns on the no-fit step", async () => {
    vi.stubGlobal("fetch", server());
    const { container, findByText } = render(
      <PlanPanel {...PROPS} playbook={{ active: REV, revisions: [REV] }} />,
    );
    const summary = container.querySelector('[data-component="WhoDoesWhat"]');
    expect(summary?.textContent).toContain("default (host): 2 steps");
    expect(summary?.textContent).toContain("writer: 1 step");
    expect(summary?.textContent).toContain("1 step with no good fit");
    expect(container.querySelectorAll('[data-component="StepAssignment"]')).toHaveLength(3);
    expect(container.querySelector('[data-fit="partial"]')).toBeTruthy();
    const warning = container.querySelector('[data-component="NoFitWarning"]');
    expect(warning?.textContent).toContain("mailer");
    // The roster loads for the description hint: writer has none.
    await findByText(/writer has no description/);
  });

  it("renders steps without assignment fields as before and does not load the roster", () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const old: PlaybookRev = { ...REV, steps: [{ key: "a", title: "Draft it", assignee: "default" }] };
    const { container, getByText } = render(
      <PlanPanel {...PROPS} playbook={{ active: old, revisions: [old] }} />,
    );
    expect(getByText("→ default")).toBeTruthy();
    expect(container.querySelector('[data-component="WhoDoesWhat"]')).toBeNull();
    expect(container.querySelector('[data-component="StepAssignment"]')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === ROSTER_URL)).toBe(false);
  });

  it("shows the reason on a proposed revision too", () => {
    vi.stubGlobal("fetch", server());
    const proposed = { ...REV, rev: 4, active: 0, activated_at: null };
    const { container } = render(
      <PlanPanel {...PROPS} playbook={{ active: null, revisions: [proposed] }} />,
    );
    const block = container.querySelector('[data-component="ProposedRevisions"]')!;
    expect(block.querySelector('[data-component="WhoDoesWhat"]')).toBeTruthy();
    expect(block.textContent).toContain("Writes reports.");
  });
});

describe("PlanPanel — the step editor's assignee picker", () => {
  it("lists the assignable roster with facts, flags profiles not in the project, and saves a hand pick as manual", async () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { container, getByText, getByLabelText } = render(
      <PlanPanel {...PROPS} playbook={{ active: REV, revisions: [REV] }} />,
    );
    fireEvent.click(getByText("Revise"));
    const picker = getByLabelText("Step 1 assignee") as HTMLSelectElement;
    await vi.waitFor(() => within(picker).getByText("researcher (not in project yet)"));
    expect(within(picker).getByText("default (host)")).toBeTruthy();
    expect(
      (within(picker).getByText("researcher (not in project yet)") as HTMLOptionElement).title,
    ).toBe("Finds and cites sources.");

    const row = container.querySelectorAll('[data-component="PlanStepRow"]')[0] as HTMLElement;
    expect(row.querySelector('[data-component="ProfileFacts"]')?.textContent).toContain("3 completed · 0 blocked · 1 failed");

    fireEvent.change(picker, { target: { value: "researcher" } });
    const facts = row.querySelector('[data-component="ProfileFacts"]')!;
    expect(facts.textContent).toContain("Finds and cites sources.");
    expect(facts.textContent).toContain("web-research, citation");
    expect(facts.textContent).toContain("14 completed · 1 blocked · 0 failed");
    expect(facts.textContent).toContain("will be added when the plan is approved");
    expect(row.querySelector('[data-component="ChangedByYou"]')).toBeTruthy();

    fireEvent.click(getByText("Save as revision"));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => url === SAVE_URL && init?.method === "POST")).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(([url, i]) => url === SAVE_URL && i?.method === "POST")!;
    const sent = JSON.parse(String(init!.body)) as { steps: Record<string, unknown>[]; base_rev?: number };
    // The revision the editor opened from, so the server carries its assignments.
    expect(sent.base_rev).toBe(3);
    expect(sent.steps[0]).toMatchObject({ assignee: "researcher", assigned_by: "manual", planner_assignee: "default" });
    expect(sent.steps[0]).not.toHaveProperty("fit");
    expect(sent.steps[0]).not.toHaveProperty("assignee_reason");
    // Untouched planner picks keep what the planner wrote.
    expect(sent.steps[1]).toMatchObject({ assignee: "writer", fit: "strong", assigned_by: "planner" });
    expect(sent.steps[2]).toMatchObject({ assignee: null, fit: "none", suggested_profile: "mailer" });
  });

  it("falls back to the project's profiles when the roster is unavailable", async () => {
    const fetchMock = server(null);
    vi.stubGlobal("fetch", fetchMock);
    const old: PlaybookRev = { ...REV, steps: [{ key: "a", title: "Draft it", assignee: "default" }] };
    const { getByText, getByLabelText, container } = render(
      <PlanPanel {...PROPS} playbook={{ active: old, revisions: [old] }} />,
    );
    fireEvent.click(getByText("Revise"));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === ROSTER_URL)).toBe(true));
    const picker = getByLabelText("Step 1 assignee") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(["", "default", "writer"]);
    expect(container.querySelector('[data-component="ProfileFacts"]')).toBeNull();

    fireEvent.click(getByText("Save as revision"));
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => url === SAVE_URL && init?.method === "POST")).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(([url, i]) => url === SAVE_URL && i?.method === "POST")!;
    const sent = JSON.parse(String(init!.body)) as { steps: Record<string, unknown>[] };
    // An untouched older step is saved exactly as before.
    expect(Object.keys(sent.steps[0]).sort()).toEqual(["assignee", "checkpoint", "depends_on", "key", "title"]);
  });
});

describe("CardDetailView — the card's assignment", () => {
  const CARD = {
    id: "t_1",
    title: "Collect pricing",
    body: null,
    status: "todo",
    assignee: "researcher",
    priority: 0,
    created_at: 1,
    started_at: null,
    completed_at: null,
    tenant: null,
    project_id: "prj_1",
    result: null,
    current_step_key: "collect",
    comments: [],
  } as ProjectCardDetail;

  it("shows why the card went to its profile", () => {
    vi.stubGlobal("fetch", server());
    const { container } = render(
      <CardDetailView
        slug="monday-digest"
        card={{
          ...CARD,
          assignment: {
            assignee: "researcher",
            fit: "strong",
            assignee_reason: "Has web-research.",
            matched_skills: ["web-research"],
            assigned_by: "planner",
          },
        }}
      />,
    );
    const block = container.querySelector('[data-component="CardAssignment"]');
    expect(block?.textContent).toContain("strong fit");
    expect(block?.textContent).toContain("Has web-research.");
    expect(block?.textContent).toContain("web-research");
  });

  it("marks a hand-changed card and leaves older cards as they were", () => {
    vi.stubGlobal("fetch", server());
    const { container, rerender } = render(
      <CardDetailView slug="monday-digest" card={{ ...CARD, assignment: { assigned_by: "manual", planner_assignee: "writer" } }} />,
    );
    expect(container.querySelector('[data-component="ChangedByYou"]')?.textContent).toContain("planner picked writer");
    rerender(<CardDetailView slug="monday-digest" card={{ ...CARD, id: "t_2" }} />);
    cleanup();
    const fresh = render(<CardDetailView slug="monday-digest" card={CARD} />);
    expect(fresh.container.querySelector('[data-component="CardAssignment"]')).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * The four button states (mockup screen 4) for every migrated project write:
 * a double click sends exactly one request, the button shows its pending
 * label and stays disabled while in flight, a failure shows the error with a
 * Retry that re-sends the same Idempotency-Key, and success shows the new
 * state from the server's answer.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/projects/monday-digest",
  useSearchParams: () => new URLSearchParams(),
}));

import { CardActions } from "@/components/projects/CardActions";
import { CardEditor } from "@/components/projects/CardEditor";
import { EditBriefSheet } from "@/components/projects/EditBriefSheet";
import { ProjectLifecycleMenu } from "@/components/projects/ProjectLifecycleMenu";
import { RunView } from "@/components/projects/RunView";
import { SummariseSheet } from "@/components/projects/SummariseSheet";
import { cardMoves } from "@/components/projects/cardMoves";
import { GuidancePanel } from "@/components/projects/panels/GuidancePanel";
import { PeoplePanel } from "@/components/projects/panels/PeoplePanel";
import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import { RunsPanel } from "@/components/projects/panels/RunsPanel";
import { SettingsPanel } from "@/components/projects/panels/SettingsPanel";
import { ToolsPanel } from "@/components/projects/panels/ToolsPanel";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";
import type {
  ProjectCardDetail,
  ProjectDetail,
  ProjectDirective,
  ProjectPlaybookResponse,
  ProjectRun,
  ProjectToolsResolution,
} from "@/types";

const NOW = Math.floor(Date.now() / 1000);
const SLUG = "monday-digest";
const BASE = `/api/projects/${SLUG}`;

const PROJECT: ProjectDetail = {
  id: "prj_1",
  slug: SLUG,
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
  owner_user_id: "leo",
  status: "active",
  cadence: "repeatable",
  schedule: "every 60m",
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
  cron_job_id: "cron_1",
  summary: null,
  summary_at: null,
  last_reviewed_at: null,
  next_run_at: null,
  outputs: [],
  members: [
    { project_id: "prj_1", user_id: "leo", role: "lead", added_by: null, added_at: NOW },
    { project_id: "prj_1", user_id: "ricky", role: "member", added_by: null, added_at: NOW },
  ],
  profiles: [
    { project_id: "prj_1", profile: "default", role: "host", added_by: null, added_at: NOW },
  ],
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
};

const RUN_BRIEF = (run_no: number, status: "waiting" | "running") => ({
  run_no,
  status,
  trigger: "manual" as const,
  started_at: NOW - 600,
  ended_at: null,
  duration_seconds: null,
  outcome: null,
  score_user: null,
});

const READY_PLAYBOOK: ProjectPlaybookResponse = {
  active: {
    project_id: "prj_1",
    rev: 1,
    body: "",
    steps: [{ key: "a", title: "A" }],
    active: 1,
    created_by: "leo",
    created_at: NOW,
    activated_at: NOW,
    note: null,
  },
  revisions: [],
};

const RUN = (over: Partial<ProjectRun>): ProjectRun => ({
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
  ...over,
});

const CARD: ProjectCardDetail = {
  id: "task_1",
  title: "Draft the digest",
  body: "Pull the threads.",
  status: "todo",
  assignee: null,
  priority: 3,
  created_at: NOW - 86_400,
  started_at: null,
  completed_at: null,
  tenant: null,
  project_id: "prj_1",
  result: null,
  current_step_key: null,
  age: null,
};

const DIRECTIVE = (over: Partial<ProjectDirective>): ProjectDirective => ({
  id: "dir_1",
  project_id: "prj_1",
  kind: "directive",
  body: "Lead with the decisions",
  scope: "project",
  target_ref: null,
  rating: null,
  author_user_id: "leo",
  created_at: NOW,
  active: 1,
  retired_at: null,
  superseded_by: null,
  ...over,
});

const RESOLUTION: ProjectToolsResolution = {
  toolsets: ["web", "terminal"],
  skills: [],
  host_profile: "default",
  effective_toolsets: ["web"],
  dropped_toolsets: ["terminal"],
  effective_skills: [],
  dropped_skills: [],
  skills_truncated: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Write {
  url: string;
  method: string;
  key: string | undefined;
  body: string | undefined;
}

/** Reads answer at once; each write waits until the test answers it. */
function fakeServer(reads?: (url: string, writes: Write[]) => unknown) {
  const writes: Write[] = [];
  const answers: Array<(res: Response) => void> = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return Promise.resolve(json(200, reads?.(String(input), writes) ?? {}));
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    writes.push({
      url: String(input),
      method,
      key: headers[IDEMPOTENCY_HEADER],
      body: typeof init.body === "string" ? init.body : undefined,
    });
    return new Promise<Response>((resolve) => answers.push(resolve));
  });
  vi.stubGlobal("fetch", fetchMock);
  const answer = async (status: number, body: unknown) => {
    const next = answers.shift();
    if (!next) throw new Error("no write is waiting for an answer");
    await act(async () => {
      next(json(status, body));
    });
  };
  return { writes, answer };
}

function buttonOf(el: HTMLElement): HTMLButtonElement | HTMLSelectElement {
  return (el.closest("button") ?? el) as HTMLButtonElement | HTMLSelectElement;
}

interface Scenario {
  name: string;
  ui: () => ReactElement;
  /** Fill in whatever the write needs before the click. */
  prepare?: (r: RenderResult) => void;
  /** The control that fires the write (looked up fresh each time). */
  control: (r: RenderResult) => HTMLElement;
  /** How the control fires; a click unless it is a select. */
  fire?: (el: HTMLElement) => void;
  pending: string;
  /** Answers for reads the component makes (default `{}`). */
  reads?: (url: string, writes: Write[]) => unknown;
  method: string;
  path: string;
  body?: unknown;
  success: unknown;
  confirmed: (r: RenderResult) => void;
}

const SCENARIOS: Scenario[] = [
  {
    name: "RunsPanel · Cancel",
    ui: () => <RunsPanel slug={SLUG} runs={[RUN_BRIEF(14, "waiting")]} />,
    control: (r) => r.getByRole("button", { name: "Cancel" }),
    pending: "Cancelling…",
    method: "POST",
    path: `${BASE}/runs/14/cancel`,
    success: { run_no: 14, status: "cancelled" },
    confirmed: () => expect(router.refresh).toHaveBeenCalled(),
  },
  {
    name: "RunsPanel · Continue",
    ui: () => <RunsPanel slug={SLUG} runs={[RUN_BRIEF(14, "waiting")]} />,
    control: (r) => r.getByRole("button", { name: "Continue" }),
    pending: "Continuing…",
    method: "POST",
    path: `${BASE}/runs/14/continue`,
    success: { run: { run_no: 14, status: "running" } },
    confirmed: () => expect(router.refresh).toHaveBeenCalled(),
  },
  {
    name: "RunView · Continue",
    ui: () => <RunView slug={SLUG} run={RUN({ run_no: 3 })} />,
    control: (r) => r.getByRole("button", { name: "Continue" }),
    pending: "Continuing…",
    method: "POST",
    path: `${BASE}/runs/3/continue`,
    success: { run: { ...RUN({ run_no: 3 }), status: "running" }, promoted: 1 },
    confirmed: (r) => expect(r.queryByRole("button", { name: "Continue" })).toBeNull(),
  },
  {
    name: "RunView · Cancel",
    ui: () => <RunView slug={SLUG} run={RUN({ run_no: 3 })} />,
    control: (r) => r.getByRole("button", { name: "Cancel" }),
    pending: "Cancelling…",
    method: "POST",
    path: `${BASE}/runs/3/cancel`,
    success: { ...RUN({ run_no: 3 }), status: "cancelled", ended_at: NOW },
    confirmed: (r) => expect(r.queryByRole("button", { name: "Cancel" })).toBeNull(),
  },
  {
    name: "RunView · Save retro",
    ui: () => <RunView slug={SLUG} run={RUN({ run_no: 3, status: "done", ended_at: NOW })} />,
    prepare: (r) =>
      fireEvent.change(
        r.getByPlaceholderText("What worked, what didn't, what to change next time…"),
        { target: { value: "Shorter intro next time" } },
      ),
    control: (r) => r.getByRole("button", { name: "Save retro" }),
    pending: "Saving…",
    method: "POST",
    path: `${BASE}/runs/3/retro`,
    body: { retro: "Shorter intro next time" },
    success: { ok: true },
    confirmed: (r) => expect(r.getByText("saved")).toBeTruthy(),
  },
  {
    name: "RunView · Save score",
    ui: () => <RunView slug={SLUG} run={RUN({ run_no: 3, status: "done", ended_at: NOW })} />,
    prepare: (r) =>
      fireEvent.click(
        within(r.getByRole("group", { name: "Score this run from 1 to 5" })).getByRole(
          "button",
          { name: "4" },
        ),
      ),
    control: (r) => r.getByRole("button", { name: "Save score" }),
    pending: "Saving…",
    method: "POST",
    path: `${BASE}/runs/3/score`,
    body: { score: 4 },
    success: { ok: true },
    confirmed: (r) => expect(r.container.textContent).toMatch(/saved/i),
  },
  {
    name: "ProjectLifecycleMenu · Archive",
    ui: () => (
      <ProjectLifecycleMenu project={PROJECT} callerUserId="leo" isInstanceAdmin={false} />
    ),
    prepare: (r) => {
      fireEvent.click(r.getByLabelText("Project actions"));
      fireEvent.click(r.getByText("Archive project…"));
    },
    control: (r) => r.getByRole("button", { name: "Archive" }),
    pending: "Archiving…",
    method: "POST",
    path: `${BASE}/archive`,
    body: {},
    success: { ...PROJECT, archived: true },
    confirmed: (r) => {
      expect(router.refresh).toHaveBeenCalled();
      expect(r.queryByRole("button", { name: "Archive" })).toBeNull();
    },
  },
  {
    name: "ProjectLifecycleMenu · Restore",
    ui: () => (
      <ProjectLifecycleMenu
        project={{ ...PROJECT, archived: true }}
        callerUserId="leo"
        isInstanceAdmin={false}
      />
    ),
    prepare: (r) => fireEvent.click(r.getByLabelText("Project actions")),
    control: (r) => r.getByRole("button", { name: "Restore project" }),
    pending: "Restoring…",
    method: "POST",
    path: `${BASE}/restore`,
    success: { ...PROJECT, archived: false },
    confirmed: () => expect(router.refresh).toHaveBeenCalled(),
  },
  {
    name: "SummariseSheet · Save summary",
    ui: () => <SummariseSheet slug={SLUG} initial="Run 14 is waiting" onClose={onClose} />,
    control: (r) => r.getByRole("button", { name: "Save summary" }),
    pending: "Saving…",
    method: "POST",
    path: `${BASE}/summarise`,
    body: { summary: "Run 14 is waiting" },
    success: { ok: true },
    confirmed: () => expect(onClose).toHaveBeenCalledTimes(1),
  },
  {
    name: "EditBriefSheet · Pause",
    ui: () => <EditBriefSheet project={PROJECT} onClose={onClose} />,
    control: (r) => r.getByRole("button", { name: "Pause the project" }),
    pending: "Pausing…",
    method: "PATCH",
    path: BASE,
    body: { status: "paused" },
    success: { ...PROJECT, status: "paused" },
    confirmed: () => expect(onClose).toHaveBeenCalledTimes(1),
  },
  {
    name: "EditBriefSheet · Save",
    ui: () => <EditBriefSheet project={PROJECT} onClose={onClose} />,
    prepare: (r) =>
      fireEvent.change(r.getByDisplayValue(PROJECT.goal ?? ""), {
        target: { value: "Everyone briefed by 9" },
      }),
    control: (r) => r.getByRole("button", { name: "Save" }),
    pending: "Saving…",
    method: "PATCH",
    path: BASE,
    body: { goal: "Everyone briefed by 9" },
    success: { ...PROJECT, goal: "Everyone briefed by 9" },
    confirmed: () => expect(onClose).toHaveBeenCalledTimes(1),
  },
  {
    name: "PlanPanel · Activate revision",
    ui: () => (
      <PlanPanel
        slug={SLUG}
        playbook={{
          active: READY_PLAYBOOK.active,
          revisions: [{ ...READY_PLAYBOOK.active!, rev: 2, active: 0, activated_at: null }],
        }}
        profiles={["default"]}
        canActivate
        archived={false}
      />
    ),
    control: (r) => r.getByRole("button", { name: "Activate" }),
    pending: "Activating…",
    method: "POST",
    path: `${BASE}/playbook/2/activate`,
    body: {},
    success: { ok: true },
    confirmed: () => expect(router.refresh).toHaveBeenCalled(),
  },
  {
    name: "PlanPanel · Draft with the agent",
    ui: () => (
      <PlanPanel
        slug={SLUG}
        playbook={READY_PLAYBOOK}
        profiles={["default"]}
        canActivate
        archived={false}
      />
    ),
    control: (r) => r.getByRole("button", { name: "Draft with the agent" }),
    pending: "Starting the draft…",
    // The panel polls the job; it reports running once a draft was started.
    reads: (url, writes) =>
      url.endsWith("/playbook/draft") && writes.length > 0 ? { status: "running" } : {},
    method: "POST",
    path: `${BASE}/playbook/draft`,
    body: {},
    success: { status: "running" },
    confirmed: (r) => expect(r.getByText("Agent is drafting…")).toBeTruthy(),
  },
  {
    name: "PlanPanel · Save as revision",
    ui: () => (
      <PlanPanel
        slug={SLUG}
        playbook={READY_PLAYBOOK}
        profiles={["default"]}
        canActivate
        archived={false}
      />
    ),
    prepare: (r) => fireEvent.click(r.getByRole("button", { name: "Revise" })),
    control: (r) => r.getByRole("button", { name: "Save as revision" }),
    pending: "Saving…",
    method: "POST",
    path: `${BASE}/playbook`,
    success: { rev: 2 },
    confirmed: (r) => {
      expect(r.queryByRole("button", { name: "Save as revision" })).toBeNull();
      expect(router.refresh).toHaveBeenCalled();
    },
  },
  {
    name: "PeoplePanel · Remove member",
    ui: () => <PeoplePanel project={PROJECT} />,
    control: (r) => r.getByRole("button", { name: "Remove ricky" }),
    pending: "Removing…",
    method: "DELETE",
    path: `${BASE}/members/ricky`,
    success: { ok: true },
    confirmed: (r) => expect(r.queryByText("ricky")).toBeNull(),
  },
  {
    name: "PeoplePanel · Add member",
    ui: () => <PeoplePanel project={PROJECT} />,
    prepare: (r) =>
      fireEvent.change(r.getByPlaceholderText("User id (e.g. leo)"), {
        target: { value: "sam" },
      }),
    control: (r) => r.getByRole("button", { name: "Add member" }),
    pending: "Adding…",
    method: "POST",
    path: `${BASE}/members`,
    success: { ok: true },
    confirmed: (r) => expect(r.getByText("sam")).toBeTruthy(),
  },
  {
    name: "PeoplePanel · Add contact",
    ui: () => <PeoplePanel project={PROJECT} />,
    prepare: (r) =>
      fireEvent.change(r.getByPlaceholderText("Name (e.g. Ricky Lui)"), {
        target: { value: "Ada Byron" },
      }),
    control: (r) => r.getByRole("button", { name: "Add contact" }),
    pending: "Adding…",
    method: "POST",
    path: `${BASE}/contacts`,
    success: {
      id: "c_1",
      project_id: "prj_1",
      name: "Ada Byron",
      role: null,
      org: null,
      platform: null,
      user_id: null,
      notes: null,
      created_by: "leo",
      created_at: NOW,
    },
    confirmed: (r) => expect(r.getByText("Ada Byron")).toBeTruthy(),
  },
  {
    name: "SettingsPanel · Save schedule",
    ui: () => <SettingsPanel project={PROJECT} canLead hasActivePlan />,
    prepare: (r) =>
      fireEvent.change(r.getByLabelText("Schedule"), { target: { value: "every 30m" } }),
    control: (r) => r.getByRole("button", { name: "Save schedule" }),
    pending: "Saving…",
    method: "PUT",
    path: `${BASE}/schedule`,
    body: { schedule: "every 30m" },
    success: { scheduled: true, schedule: "every 30m", next_run_at: null },
    confirmed: (r) => {
      expect(r.getByText("Schedule saved.")).toBeTruthy();
      expect(r.getByText("Runs every 30m")).toBeTruthy();
    },
  },
  {
    name: "SettingsPanel · Remove schedule",
    ui: () => <SettingsPanel project={PROJECT} canLead hasActivePlan />,
    control: (r) => r.getByRole("button", { name: "Remove" }),
    pending: "Removing…",
    method: "DELETE",
    path: `${BASE}/schedule`,
    success: { scheduled: false },
    confirmed: (r) => expect(r.getByText(/^Schedule removed/)).toBeTruthy(),
  },
  {
    name: "SettingsPanel · Save autonomy",
    ui: () => <SettingsPanel project={PROJECT} canLead hasActivePlan />,
    prepare: (r) =>
      fireEvent.click(r.container.querySelector('input[value="manual"]') as HTMLElement),
    control: (r) => r.getByRole("button", { name: "Save autonomy" }),
    pending: "Saving…",
    method: "PATCH",
    path: `${BASE}/autonomy`,
    body: { autonomy: "manual" },
    success: { autonomy: "manual" },
    confirmed: (r) => expect(r.getByText("Autonomy updated.")).toBeTruthy(),
  },
  {
    name: "ToolsPanel · Save",
    ui: () => <ToolsPanel project={PROJECT} />,
    prepare: (r) =>
      fireEvent.change(r.getByPlaceholderText("e.g. web, file, terminal"), {
        target: { value: "web, terminal" },
      }),
    control: (r) => r.getByRole("button", { name: "Save" }),
    pending: "Saving…",
    method: "PATCH",
    path: `${BASE}/tools`,
    success: RESOLUTION,
    confirmed: (r) => expect(r.getByText("Dropped (not on host): terminal")).toBeTruthy(),
  },
  {
    name: "GuidancePanel · Add",
    ui: () => <GuidancePanel slug={SLUG} initial={{ directives: [], applies_from: "next_run" }} />,
    prepare: (r) =>
      fireEvent.change(r.getByPlaceholderText("Add an instruction…"), {
        target: { value: "Keep it short" },
      }),
    control: (r) => r.getByRole("button", { name: "Add" }),
    pending: "Adding…",
    method: "POST",
    path: `${BASE}/directives`,
    body: { body: "Keep it short" },
    success: DIRECTIVE({ id: "dir_9", body: "Keep it short" }),
    confirmed: (r) => expect(r.getByText("Keep it short")).toBeTruthy(),
  },
  {
    name: "GuidancePanel · Retire",
    ui: () => <GuidancePanel slug={SLUG} initial={{ directives: [DIRECTIVE({})], applies_from: "next_run" }} />,
    control: (r) => r.getByRole("button", { name: "Retire" }),
    pending: "Retiring…",
    method: "POST",
    path: `${BASE}/directives/dir_1/retire`,
    success: { ok: true },
    confirmed: (r) => expect(r.queryByText("Lead with the decisions")).toBeNull(),
  },
  {
    name: "GuidancePanel · Activate proposed",
    ui: () => (
      <GuidancePanel
        slug={SLUG}
        initial={{
          directives: [],
          proposed: [DIRECTIVE({ id: "dir_2", body: "Cite sources", active: 0 })],
          applies_from: "next_run",
        }}
      />
    ),
    control: (r) => r.getByRole("button", { name: "Activate" }),
    pending: "Activating…",
    method: "POST",
    path: `${BASE}/directives/dir_2/activate`,
    success: { ok: true },
    confirmed: (r) => {
      expect(r.queryByRole("button", { name: "Activate" })).toBeNull();
      expect(r.getByText("Cite sources")).toBeTruthy();
    },
  },
  {
    name: "CardEditor · Save",
    ui: () => <CardEditor slug={SLUG} card={CARD} profiles={["default"]} />,
    prepare: (r) => {
      fireEvent.click(r.getByRole("button", { name: "Edit card" }));
      fireEvent.change(r.getByDisplayValue(CARD.title), {
        target: { value: "Draft the digest (v2)" },
      });
    },
    control: (r) => r.getByRole("button", { name: "Save" }),
    pending: "Saving…",
    method: "PATCH",
    path: `${BASE}/cards/task_1`,
    success: { ...CARD, title: "Draft the digest (v2)" },
    confirmed: (r) => {
      expect(r.queryByRole("button", { name: "Save" })).toBeNull();
      expect(router.refresh).toHaveBeenCalled();
    },
  },
  {
    name: "CardEditor · Move",
    ui: () => <CardEditor slug={SLUG} card={CARD} profiles={["default"]} />,
    control: (r) => r.getByLabelText("Move card"),
    fire: (el) =>
      fireEvent.change(el, { target: { value: cardMoves(CARD.status)[0]!.to } }),
    pending: "Moving…",
    method: "PATCH",
    path: `${BASE}/cards/task_1`,
    body: { status: cardMoves(CARD.status)[0]!.to },
    success: { ...CARD, status: cardMoves(CARD.status)[0]!.to },
    confirmed: () => expect(router.refresh).toHaveBeenCalled(),
  },
  {
    name: "CardActions · Stop",
    ui: () => <CardActions slug={SLUG} taskId="task_1" status="running" />,
    control: (r) => r.getByRole("button", { name: "Stop" }),
    pending: "Stopping…",
    method: "POST",
    path: `${BASE}/cards/task_1/stop`,
    success: { ok: true },
    confirmed: () => expect(router.refresh).toHaveBeenCalled(),
  },
];

const onClose = vi.fn();

describe.each(SCENARIOS)("$name", (scenario) => {
  const setup = () => {
    onClose.mockClear();
    const server = fakeServer(scenario.reads);
    const r = render(scenario.ui());
    scenario.prepare?.(r);
    const fire = scenario.fire ?? ((el: HTMLElement) => fireEvent.click(el));
    return { server, r, fire };
  };

  it("double click sends one request and shows the pending state", async () => {
    const { server, r, fire } = setup();
    const control = scenario.control(r);
    fire(control);
    fire(control);
    fire(control);

    expect(server.writes).toHaveLength(1);
    const [write] = server.writes;
    expect(write!.method).toBe(scenario.method);
    expect(write!.url).toBe(scenario.path);
    expect(write!.key).toBeTruthy();
    if (scenario.body !== undefined) {
      expect(JSON.parse(write!.body ?? "null")).toEqual(scenario.body);
    }
    const target = buttonOf(control);
    await waitFor(() => {
      if (target instanceof HTMLButtonElement) {
        expect(target.textContent).toContain(scenario.pending);
        expect(target.getAttribute("aria-busy")).toBe("true");
      } else {
        expect(r.getAllByText(scenario.pending).length).toBeGreaterThan(0);
      }
    });
    expect(target.disabled).toBe(true);
    await server.answer(200, scenario.success);
  });

  it("success shows the new state", async () => {
    const { server, r, fire } = setup();
    fire(scenario.control(r));
    await server.answer(200, scenario.success);
    await waitFor(() => scenario.confirmed(r));
    expect(server.writes).toHaveLength(1);
  });

  it("failure shows the error, re-enables, and Retry re-sends the same key", async () => {
    const { server, r, fire } = setup();
    fire(scenario.control(r));
    await server.answer(502, { detail: "The upstream hiccupped" });

    const alert = await r.findByRole("alert");
    expect(alert.textContent).toBe("The upstream hiccupped");
    expect(buttonOf(scenario.control(r)).disabled).toBe(false);

    const retry = r.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]).toEqual(server.writes[0]);
    await server.answer(200, scenario.success);
    await waitFor(() => scenario.confirmed(r));
    expect(r.queryByRole("alert")).toBeNull();
  });
});

describe("per-row locks", () => {
  it("RunsPanel rows lock independently", async () => {
    const server = fakeServer();
    const r = render(
      <RunsPanel slug={SLUG} runs={[RUN_BRIEF(14, "waiting"), RUN_BRIEF(15, "running")]} />,
    );
    const rows = r.container.querySelectorAll<HTMLElement>('[data-component="RunRowActions"]');
    expect(rows).toHaveLength(2);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Cancel" }));
    await r.findByText("Cancelling…");
    const other = within(rows[1]!).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(other.disabled).toBe(false);
    fireEvent.click(other);
    expect(server.writes.map((w) => w.url)).toEqual([
      `${BASE}/runs/14/cancel`,
      `${BASE}/runs/15/cancel`,
    ]);
    expect(server.writes[0]!.key).not.toBe(server.writes[1]!.key);
  });

  it("PeoplePanel rows lock independently", async () => {
    const server = fakeServer();
    const r = render(<PeoplePanel project={PROJECT} />);
    fireEvent.click(r.getByRole("button", { name: "Remove ricky" }));
    const leo = r.getByRole("button", { name: "Remove leo" }) as HTMLButtonElement;
    expect(leo.disabled).toBe(false);
    fireEvent.click(leo);
    expect(server.writes.map((w) => w.url)).toEqual([
      `${BASE}/members/ricky`,
      `${BASE}/members/leo`,
    ]);
  });

  it("a fresh click after success gets a new key", async () => {
    const server = fakeServer();
    const r = render(<RunsPanel slug={SLUG} runs={[RUN_BRIEF(14, "waiting")]} />);
    fireEvent.click(r.getByRole("button", { name: "Cancel" }));
    await server.answer(200, {});
    await waitFor(() =>
      expect((r.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(r.getByRole("button", { name: "Cancel" }));
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]!.key).not.toBe(server.writes[0]!.key);
  });
});


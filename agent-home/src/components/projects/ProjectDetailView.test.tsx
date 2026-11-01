import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ProjectDetailView + RunView use next/navigation — stub the router hooks
// so SSR rendering works.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { CardActions } from "@/components/projects/CardActions";
import { CardDetailView } from "@/components/projects/CardDetailView";
import { ProjectDetailView } from "@/components/projects/ProjectDetailView";
import { RunView } from "@/components/projects/RunView";
import { BoardPanel } from "@/components/projects/panels/BoardPanel";
import { BriefPanel } from "@/components/projects/panels/BriefPanel";
import { FilesPanel } from "@/components/projects/panels/FilesPanel";
import { GuidancePanel } from "@/components/projects/panels/GuidancePanel";
import { LinkRow } from "@/components/projects/panels/LinkRow";
import { MemoriesPanel } from "@/components/projects/panels/MemoriesPanel";
import { OutputsPanel } from "@/components/projects/panels/OutputsPanel";
import { PeoplePanel } from "@/components/projects/panels/PeoplePanel";
import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import { ProgressPanel } from "@/components/projects/panels/ProgressPanel";
import { ReferencesPanel } from "@/components/projects/panels/ReferencesPanel";
import { RunsPanel } from "@/components/projects/panels/RunsPanel";
import { ToolsPanel } from "@/components/projects/panels/ToolsPanel";
import type {
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectDirective,
  ProjectLink,
  ProjectOutputWithDeliveries,
  ProjectPlaybookResponse,
  ProjectRun,
} from "@/types";

const NOW = Math.floor(Date.now() / 1000);

const LINK = (over: Partial<ProjectLink>): ProjectLink => ({
  project_id: "prj_1",
  kind: "url",
  profile: "default",
  ref: "https://example.com",
  label: null,
  added_by: "leo",
  added_at: NOW,
  resolved: true,
  ...over,
});

const PROJECT: ProjectDetail = {
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
  cron_job_id: "cron_1",
  summary: "Where this stands: run 14 waiting on your answer about the tone.",
  summary_at: NOW - 3_600,
  last_reviewed_at: null,
  next_run_at: NOW + 3 * 86_400,
  outputs: [],
  members: [{ project_id: "prj_1", user_id: "leo", role: "lead", added_by: null, added_at: NOW }],
  profiles: [
    { project_id: "prj_1", profile: "default", role: "host", added_by: null, added_at: NOW },
    { project_id: "prj_1", profile: "worker", role: "worker", added_by: null, added_at: NOW },
  ],
  contacts: [],
  links: {},
  progress: {
    rung: "outputs",
    label: "outputs",
    headline: "1 of 2 outputs accepted",
    accepted: 1,
    required: 2,
    cards: { total: 3, done: 1, running: 1, blocked: 1 },
  },
  score: null,
  health: "attention",
  runs: [
    {
      run_no: 14,
      status: "waiting",
      trigger: "schedule",
      started_at: NOW - 7_200,
      ended_at: null,
      duration_seconds: null,
      outcome: null,
      score_user: null,
    },
  ],
  card_rollup: { total: 3, done: 1, running: 1, blocked: 1 },
  recent_events: [],
};

const CARD = (over: Partial<ProjectBoardTask>): ProjectBoardTask => ({
  id: "task_1",
  title: "Draft the digest",
  body: null,
  status: "running",
  assignee: "default",
  priority: 3,
  created_at: NOW - 86_400,
  started_at: NOW - 3_600,
  completed_at: null,
  tenant: null,
  project_id: "prj_1",
  result: null,
  current_step_key: "draft",
  ...over,
});

const BOARD: ProjectBoardView = {
  columns: [
    { name: "todo", tasks: [CARD({ id: "task_1", status: "todo" })] },
    { name: "running", tasks: [CARD({ id: "task_2" })] },
    { name: "blocked", tasks: [CARD({ id: "task_3", status: "blocked", title: "Blocked by tone decision" })] },
  ],
};

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

const OUTPUT = (over: Partial<ProjectOutputWithDeliveries>): ProjectOutputWithDeliveries => ({
  id: "out_1",
  project_id: "prj_1",
  seq: 1,
  title: "The digest itself",
  spec: null,
  kind: "artifact",
  required: 1,
  recurring: 1,
  status: "pending",
  delivered_at: null,
  accepted_at: null,
  accepted_by: null,
  created_at: NOW,
  deliveries: [],
  ...over,
});

describe("detail panels", () => {
  it("BriefPanel renders the requirements and the audience chip", () => {
    const html = renderToStaticMarkup(<BriefPanel project={PROJECT} />);
    expect(html).toContain("The digest the team reads before standup.");
    expect(html).toContain("the platform team");
  });

  it("OutputsPanel puts undelivered required outputs first", () => {
    const html = renderToStaticMarkup(
      <OutputsPanel
        slug="monday-digest"
        outputs={[
          OUTPUT({ id: "out_delivered", seq: 1, status: "delivered", delivered_at: NOW }),
          OUTPUT({ id: "out_pending", seq: 2, title: "Still owed" }),
          OUTPUT({ id: "out_optional", seq: 3, title: "Nice to have", required: 0 }),
        ]}
      />,
    );
    const pending = html.indexOf("Still owed");
    const delivered = html.indexOf("The digest itself");
    const optional = html.indexOf("Nice to have");
    expect(pending).toBeGreaterThan(-1);
    expect(pending).toBeLessThan(delivered);
    expect(delivered).toBeLessThan(optional);
    // Accept lives in the Outputs panel and only for delivered rows, and the
    // row says why it is waiting on a person.
    expect(html).toContain("Accept");
    expect(html).toContain("Accepting is");
    expect(html).toContain("a human act");
  });

  it("OutputsPanel shows the add-output form when not archived", () => {
    const html = renderToStaticMarkup(
      <OutputsPanel slug="monday-digest" outputs={[]} />,
    );
    expect(html).toContain('data-component="AddOutputForm"');
    expect(html).toContain("Add output");
  });

  it("OutputsPanel hides the add-output form when archived", () => {
    const html = renderToStaticMarkup(
      <OutputsPanel slug="monday-digest" outputs={[]} archived />,
    );
    expect(html).not.toContain('data-component="AddOutputForm"');
  });

  it("ProgressPanel shows the ladder headline and blocked cards", () => {
    const html = renderToStaticMarkup(
      <ProgressPanel
        slug="monday-digest"
        project={PROJECT}
        blockedCards={[CARD({ id: "task_3", status: "blocked", title: "Blocked by tone decision" })]}
        readiness={[]}
      />,
    );
    expect(html).toContain("1 of 2 outputs accepted");
    expect(html).toContain("Blocked by tone decision");
    expect(html).toContain("/projects/monday-digest/cards/task_3");
  });

  it("BoardPanel degrades when the board read failed, and says so", () => {
    const html = renderToStaticMarkup(<BoardPanel slug="monday-digest" board={null} />);
    expect(html).toContain("unavailable");
  });

  it("BoardPanel renders columns and card links", () => {
    const html = renderToStaticMarkup(<BoardPanel slug="monday-digest" board={BOARD} />);
    expect(html).toContain("blocked");
    expect(html).toContain("/projects/monday-digest/cards/task_2");
  });

  it("RunsPanel links each run row to the run page", () => {
    const html = renderToStaticMarkup(<RunsPanel slug="monday-digest" runs={PROJECT.runs} />);
    expect(html).toContain("/projects/monday-digest/runs/14");
    expect(html).toContain("waiting");
  });

  it("RunsPanel puts Continue / Cancel / Stop inline on a live run only", () => {
    const live = renderToStaticMarkup(<RunsPanel slug="monday-digest" runs={PROJECT.runs} />);
    expect(live).toContain('data-component="RunRowActions"');
    expect(live).toContain(">Continue<");
    expect(live).toContain(">Cancel<");
    expect(live).toContain("Stop now");
    expect(live).toContain("waiting for you");

    const settled = renderToStaticMarkup(
      <RunsPanel
        slug="monday-digest"
        runs={[{ ...PROJECT.runs[0], status: "done", duration_seconds: 120, ended_at: NOW }]}
      />,
    );
    expect(settled).not.toContain('data-component="RunRowActions"');

    const archived = renderToStaticMarkup(
      <RunsPanel slug="monday-digest" runs={PROJECT.runs} archived />,
    );
    expect(archived).not.toContain('data-component="RunRowActions"');
  });

  it("BoardPanel offers New card in startable columns and a move per card", () => {
    const html = renderToStaticMarkup(
      <BoardPanel
        slug="monday-digest"
        board={{ columns: [{ name: "triage", tasks: [] }, { name: "ready", tasks: [] }, ...BOARD.columns] }}
      />,
    );
    // triage / ready are startable; todo / running / blocked are not.
    expect(html.match(/\+ New card/g)?.length).toBe(2);
    expect(html).toContain('aria-label="Move Draft the digest"');
    expect(html).toContain("Approve — make ready");
    expect(html).toContain("Unblock — make ready");

    const archived = renderToStaticMarkup(
      <BoardPanel slug="monday-digest" board={BOARD} archived />,
    );
    expect(archived).not.toContain("New card");
    expect(archived).not.toContain("Move to");
  });

  const PLAN_PROPS = {
    slug: "monday-digest",
    profiles: ["default"],
    canActivate: true,
    archived: false,
  };

  it("PlanPanel covers the no-plan state", () => {
    const html = renderToStaticMarkup(
      <PlanPanel {...PLAN_PROPS} playbook={null} />,
    );
    expect(html).toContain("Plan");
    expect(html).toContain("unavailable");
  });

  it("PlanPanel offers Write plan and Draft with the agent when no plan is active", () => {
    const html = renderToStaticMarkup(
      <PlanPanel {...PLAN_PROPS} playbook={{ active: null, revisions: [] }} />,
    );
    expect(html).toContain("Write plan");
    expect(html).toContain('data-component="DraftPlanWithAgent"');
    expect(html).toContain("Draft with the agent");
    // The agent-draft door never leaves the project page for chat.
    expect(html).not.toContain("/chat?");
  });

  it("PlanPanel renders the active revision's steps and provenance", () => {
    const playbook: ProjectPlaybookResponse = {
      active: {
        project_id: "prj_1",
        rev: 3,
        body: "Write, review, send.",
        steps: [
          { key: "draft", title: "Draft it", assignee: "default" },
          { key: "send", title: "Send it", checkpoint: true },
        ],
        active: 1,
        created_by: "leo",
        created_at: NOW - 86_400,
        activated_at: NOW - 43_200,
        note: "added the send checkpoint",
      },
      revisions: [],
    };
    const html = renderToStaticMarkup(
      <PlanPanel {...PLAN_PROPS} playbook={playbook} />,
    );
    expect(html).toContain("Draft it");
    expect(html).toContain("Send it");
    expect(html).toContain("revision 3");
    expect(html).toContain("Revise");
  });

  it("PlanPanel shows a retro's proposed revision awaiting a decision", () => {
    const playbook: ProjectPlaybookResponse = {
      active: null,
      revisions: [
        {
          project_id: "prj_1",
          rev: 2,
          body: "Draft, then read it aloud before sending.",
          steps: [],
          active: 0,
          created_by: "leo",
          created_at: NOW - 3_600,
          activated_at: null,
          note: "proposed by run 14",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <PlanPanel {...PLAN_PROPS} playbook={playbook} />,
    );
    expect(html).toContain('data-component="ProposedRevisions"');
    expect(html).toContain("awaiting a decision");
    expect(html).toContain("proposed by run 14");
    expect(html).toContain(">Activate<");
    expect(html).toContain('data-action="discard-revision"');
    // A pending proposal is the only decision on the table — drafting or
    // writing on top of it would just stack another undecided revision.
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("activate or discard it first");

    const member = renderToStaticMarkup(
      <PlanPanel {...PLAN_PROPS} canActivate={false} playbook={playbook} />,
    );
    expect(member).not.toContain(">Activate<");
    expect(member).not.toContain('data-action="discard-revision"');
    expect(member).toContain("a lead activates or discards");
  });

  it("GuidancePanel shows proposed directives with the member's Activate", () => {
    const proposed: ProjectDirective = {
      id: "dir_1",
      project_id: "prj_1",
      kind: "directive",
      body: "Never email before 9am",
      scope: "project",
      target_ref: null,
      rating: null,
      author_user_id: "leo",
      created_at: NOW - 3_600,
      active: 0,
      retired_at: null,
      superseded_by: null,
    };
    const html = renderToStaticMarkup(
      <GuidancePanel
        slug="monday-digest"
        initial={{ directives: [], proposed: [proposed], applies_from: "next run" }}
      />,
    );
    expect(html).toContain('data-component="ProposedDirectives"');
    expect(html).toContain("Never email before 9am");
    expect(html).toContain("Activate");
  });

  it("PeoplePanel marks the host profile", () => {
    const html = renderToStaticMarkup(<PeoplePanel project={PROJECT} />);
    expect(html).toContain("host");
    expect(html).toContain("worker");
    expect(html).toContain("leo");
  });

  it("PeoplePanel shows add-member and add-contact forms with the distinction copy", () => {
    const html = renderToStaticMarkup(<PeoplePanel project={PROJECT} />);
    expect(html).toContain('data-component="AddMemberForm"');
    expect(html).toContain('data-component="AddContactForm"');
    expect(html).toContain("Add member");
    expect(html).toContain("Add contact");
    // The one-line distinction: members have a box account; contacts don't.
    expect(html).toContain("box account");
    expect(html).toContain("outside the box");
  });

  it("PeoplePanel hides writes when archived", () => {
    const html = renderToStaticMarkup(
      <PeoplePanel project={{ ...PROJECT, archived: true }} archived />,
    );
    expect(html).not.toContain('data-component="AddMemberForm"');
    expect(html).not.toContain('data-component="AddContactForm"');
  });

  it("FilesPanel collapses to the Add affordance when empty", () => {
    const html = renderToStaticMarkup(<FilesPanel project={PROJECT} />);
    expect(html).toContain("No files yet");
  });

  it("FilesPanel offers Add link and Upload file when not archived", () => {
    const html = renderToStaticMarkup(<FilesPanel project={PROJECT} />);
    expect(html).toContain("Add link");
    expect(html).toContain("Upload file");
  });

  it("FilesPanel hides writes and shows archived copy when archived", () => {
    const html = renderToStaticMarkup(
      <FilesPanel project={{ ...PROJECT, archived: true }} archived />,
    );
    expect(html).toContain("archived");
    expect(html).not.toContain("Upload file");
  });

  it("ReferencesPanel and MemoriesPanel ask for inputs when empty (never hide)", () => {
    expect(renderToStaticMarkup(<ReferencesPanel project={PROJECT} />)).toContain(
      "No links or notes yet",
    );
    const memories = renderToStaticMarkup(<MemoriesPanel project={PROJECT} />);
    expect(memories).toContain("No memories linked yet");
    expect(memories).toContain("Add memory");
  });

  it("FilesPanel labels samples as templates and references as reading", () => {
    const html = renderToStaticMarkup(
      <FilesPanel
        project={{
          ...PROJECT,
          links: {
            sample: [LINK({ kind: "sample", ref: "sample.md", label: "Match this" })],
            reference: [LINK({ kind: "reference", ref: "ref.md", label: "Read this" })],
          },
        }}
      />,
    );
    expect(html).toContain("Template to match");
    expect(html).toContain("Reference to read");
    expect(html).toContain("Match this");
    expect(html).toContain("Read this");
  });

  it("ToolsPanel splits the CSV narrowing into chips", () => {
    const html = renderToStaticMarkup(<ToolsPanel project={PROJECT} />);
    expect(html).toContain("web");
    expect(html).toContain("file");
    expect(html).toContain("digest-writer");
    expect(html).toContain("default");
  });

  it("ToolsPanel shows the edit form when not archived", () => {
    const html = renderToStaticMarkup(<ToolsPanel project={PROJECT} />);
    expect(html).toContain('data-component="ToolsEditForm"');
    expect(html).toContain("Save");
  });

  it("ToolsPanel hides the edit form when archived", () => {
    const html = renderToStaticMarkup(
      <ToolsPanel project={{ ...PROJECT, archived: true }} archived />,
    );
    expect(html).not.toContain('data-component="ToolsEditForm"');
  });
});

describe("LinkRow", () => {
  it("maps kinds onto the right hrefs", () => {
    const url = renderToStaticMarkup(<LinkRow link={LINK({})} />);
    expect(url).toContain('href="https://example.com"');
    expect(url).toContain('target="_blank"');

    const arrival = renderToStaticMarkup(
      <LinkRow link={LINK({ kind: "arrival", ref: "inc_1", label: "A file from WhatsApp" })} />,
    );
    expect(arrival).toContain('href="/inbox/inc_1"');

    const todo = renderToStaticMarkup(
      <LinkRow link={LINK({ kind: "todo", ref: "todo_1" })} />,
    );
    expect(todo).toContain('href="/todos/todo_1"');

    // No known surface: a static row, never a dead link.
    const memory = renderToStaticMarkup(
      <LinkRow link={LINK({ kind: "memory", ref: "mem_1" })} />,
    );
    expect(memory).not.toContain("<a");
  });

  it("greys an unresolved pointer instead of leaking content", () => {
    const html = renderToStaticMarkup(
      <LinkRow link={LINK({ kind: "todo", ref: "todo_1", resolved: null })} />,
    );
    expect(html).toContain("text-[var(--color-muted)]");
  });

  it("shows a readable file name instead of the raw storage path", () => {
    const html = renderToStaticMarkup(
      <LinkRow
        link={LINK({
          kind: "file",
          ref: "leo_owner/ai-i-train/fde2b2b6-2131-4abc-9def-0123456789ab-Lesson_Plan.pdf",
          label: null,
          resolved: true,
        })}
      />,
    );
    expect(html).not.toContain("leo_owner/");
    expect(html).not.toContain("fde2b2b6");
    expect(html).toContain("Lesson Plan.pdf");

    // An explicit label always wins over the derived name.
    const labelled = renderToStaticMarkup(
      <LinkRow
        link={LINK({
          kind: "file",
          ref: "leo_owner/ai-i-train/fde2b2b6-2131-4abc-9def-0123456789ab-Lesson_Plan.pdf",
          label: "The plan",
          resolved: true,
        })}
      />,
    );
    expect(labelled).toContain("The plan");
    expect(labelled).not.toContain("Lesson Plan.pdf");
  });
});

/** The slice of the page that is the slim header. */
function header(html: string): string {
  return html.slice(html.indexOf('data-component="ProjectHeader"'), html.indexOf("</header>"));
}

/** The slice of the page that is the journey bar. */
function bar(html: string): string {
  const at = html.indexOf('data-component="JourneyBar"');
  const out = html.slice(at, html.indexOf("</section>", at));
  return out;
}

describe("ProjectDetailView", () => {
  it("renders the header, actions and the §13 panel order", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={PROJECT}
        board={BOARD}
        playbook={null}
        directives={null}
        callerUserId="leo"
        isInstanceAdmin={false}
      />,
    );
    expect(html).toContain('data-component="ProjectDetailView"');
    expect(html).toContain("Send the Monday digest");
    // A waiting run: the journey bar's one button is Continue.
    expect(bar(html)).toContain("Continue run 14");
    expect(bar(html)).toContain('data-phase="running"');
    // The agent's standing line rides under the header, with its freshness
    // and the door to rewrite it.
    expect(html).toContain("Where this stands");
    expect(html).toContain("Summarised");
    expect(html).toContain("Update summary");
    // Dashboard + tabs: every section is one tab away, the Dashboard leads.
    expect(html).toContain('data-component="ProjectTabsNav"');
    for (const label of ["Dashboard", "Board", "Outputs", "Iterations", "Inputs", "Plan", "Settings"]) {
      expect(html).toContain(`>${label}`);
    }
    expect(html).toContain('data-active-tab="dashboard"');
    expect(html).not.toContain('data-component="PanelAnchors"');
  });

  it("lands on the Dashboard with Progress ahead of Outputs", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={{
          ...PROJECT,
          members: [],
          output_rollup: {
            total: 2,
            required: 2,
            delivered: 2,
            accepted: 1,
            awaiting_acceptance: 1,
          },
        }}
        board={BOARD}
        playbook={null}
        directives={null}
        callerUserId="leo"
        isInstanceAdmin={false}
      />,
    );
    // The journey bar sits above the tabs, ahead of Where it stands.
    const barAt = html.indexOf('data-component="JourneyBar"');
    expect(barAt).toBeGreaterThan(-1);
    expect(barAt).toBeLessThan(html.indexOf('data-component="ProjectTabsNav"'));
    expect(html).not.toContain('data-component="NextActionHero"');
    // Run 14 is waiting: the bar's one click is Continue.
    expect(bar(html)).toContain('data-state="waiting"');
    expect(bar(html)).toContain("Continue run 14");
    // Settings-tab panels stay out of the Dashboard.
    expect(html).not.toContain('data-component="ToolsPanel"');
  });

  it("renders the tab named by ?tab=", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={PROJECT}
        board={BOARD}
        playbook={null}
        directives={null}
        callerUserId="leo"
        isInstanceAdmin={false}
        initialTab="settings"
      />,
    );
    expect(html).toContain('data-active-tab="settings"');
    expect(html).toContain('data-component="ToolsPanel"');
    expect(html).not.toContain('data-component="DashboardTab"');
    const unknown = renderToStaticMarkup(
      <ProjectDetailView
        project={PROJECT}
        board={BOARD}
        playbook={null}
        directives={null}
        callerUserId="leo"
        isInstanceAdmin={false}
        initialTab="nope"
      />,
    );
    expect(unknown).toContain('data-active-tab="dashboard"');
  });

  it("never puts Run now / Activate / Continue in the header — the journey bar owns them", () => {
    for (const project of [
      { ...PROJECT, status: "planning" as const },
      { ...PROJECT, outputs: [OUTPUT({ id: "out_1" })] },
      { ...PROJECT, outputs: [OUTPUT({ id: "out_1" })], runs: [{ ...PROJECT.runs[0], run_no: 1, status: "running" as const }] },
    ]) {
      const html = renderToStaticMarkup(
        <ProjectDetailView
          project={project}
          board={BOARD}
          playbook={READY_PLAYBOOK}
          directives={null}
          callerUserId="leo"
          isInstanceAdmin={false}
        />,
      );
      const head = header(html);
      expect(head).not.toMatch(/<button[^>]*>(Run now|Activate|Continue run \d+|Start iteration \d+)<\/button>/);
      expect(head).not.toContain('data-action="run-now"');
      // Add / Edit / Summarise ride in the compact toolbar; goal etc. under About.
      expect(head).toContain('data-component="ProjectToolbar"');
      expect(head).toContain('data-component="ProjectAbout"');
      expect(bar(html)).toContain('id="journey-primary"');
    }
  });

  it("offers Activate in the journey bar until the project is active", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={{ ...PROJECT, status: "planning", runs: [], outputs: [OUTPUT({ id: "out_1" })], card_rollup: { total: 0, done: 0, running: 0, blocked: 0 } }}
        board={null}
        playbook={READY_PLAYBOOK}
        directives={null}
        callerUserId="leo"
        isInstanceAdmin={false}
      />,
    );
    expect(bar(html)).toContain('data-phase="setup"');
    expect(bar(html)).toContain("4 of 5 ready — next: activate the project");
    // Inputs outrank activation in nextAction; the guide line still activates.
    expect(bar(html)).toMatch(/<button[^>]*>Activate<\/button>/);
    expect(html).not.toContain("Run now");
  });

  it("explains what blocks a run and disables Run now until it is ready", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={PROJECT}
        board={BOARD}
        playbook={{ active: null, revisions: [] }}
        directives={null}
        doctor={{
          slug: PROJECT.slug,
          health: "attention",
          findings: [
            { code: "no_active_playbook", severity: "attention", detail: "no plan" },
            { code: "cron_job_missing", severity: "attention", detail: "The cron job is gone." },
          ],
          clean: false,
        }}
        callerUserId="leo"
        isInstanceAdmin={false}
        initialTab="settings"
      />,
    );
    expect(html).toContain('data-component="ReadinessChecklist"');
    expect(html).toContain("Before it can run");
    // Missing outputs + plan link to their tabs; the doctor's extra finding rides along.
    expect(html).toContain('href="?tab=outputs"');
    expect(html).toContain('href="?tab=plan"');
    expect(html).toContain("The cron job is gone.");
    expect(html).not.toContain("no plan");
    // The bar guides through the gaps, first one first.
    expect(bar(html)).toContain("3 of 5 ready — next: declare an output");
    // Lead-only edit + settings panel are present.
    expect(html).toContain(">Edit<");
    expect(html).toContain('data-component="SettingsPanel"');
    expect(html).toContain("every monday 09:00");
    expect(html).toContain('data-component="AutonomyControl"');
  });

  it("hides the checklist once every precondition holds", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={{
          ...PROJECT,
          outputs: [OUTPUT({ id: "out_1" })],
          runs: [],
          card_rollup: { total: 0, done: 0, running: 0, blocked: 0 },
        }}
        board={null}
        playbook={{
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
        }}
        directives={null}
        doctor={{ slug: PROJECT.slug, health: "ok", findings: [], clean: true }}
        callerUserId="leo"
        isInstanceAdmin={false}
      />,
    );
    expect(html).not.toContain('data-component="ReadinessChecklist"');
    expect(bar(html)).toContain('data-phase="ready"');
    expect(bar(html)).not.toContain('data-component="JourneyReadiness"');
  });

  it("disables Run now and links the open run while one is in progress", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={{
          ...PROJECT,
          outputs: [OUTPUT({ id: "out_1" })],
          runs: [{ ...PROJECT.runs[0], run_no: 1, status: "running" }],
        }}
        board={null}
        playbook={READY_PLAYBOOK}
        directives={null}
        doctor={{ slug: PROJECT.slug, health: "ok", findings: [], clean: true }}
        callerUserId="leo"
        isInstanceAdmin={false}
      />,
    );
    expect(bar(html)).toContain('data-phase="running"');
    // No inputs yet outranks watching the run; the run is still the step.
    expect(bar(html)).not.toContain("Start iteration");
    expect(html).not.toContain("Continue run");
  });

  it("disables Run now while a run waits, keeping Continue as the way on", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={{ ...PROJECT, outputs: [OUTPUT({ id: "out_1" })] }}
        board={BOARD}
        playbook={READY_PLAYBOOK}
        directives={null}
        doctor={{ slug: PROJECT.slug, health: "ok", findings: [], clean: true }}
        callerUserId="leo"
        isInstanceAdmin={false}
      />,
    );
    expect(html).not.toContain("Run now");
    expect(bar(html)).toContain("Continue run 14");
    expect(html).not.toContain("Run 14 in progress");
  });

  it("hides Edit and the settings controls from a plain member", () => {
    const html = renderToStaticMarkup(
      <ProjectDetailView
        project={{ ...PROJECT, owner_user_id: "someone-else", members: [{ ...PROJECT.members[0], user_id: "leo", role: "member" }] }}
        board={BOARD}
        playbook={null}
        directives={null}
        callerUserId="leo"
        isInstanceAdmin={false}
      />,
    );
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain("Save schedule");
  });
});

describe("CardDetailView", () => {
  const DETAIL = { ...CARD({ status: "todo", body: "Pull the week's threads." }), age: null };

  it("offers the editor with the project's profiles and the column moves", () => {
    const html = renderToStaticMarkup(
      <CardDetailView slug="s" card={DETAIL} profiles={["default", "worker"]} />,
    );
    expect(html).toContain('data-component="CardEditor"');
    expect(html).toContain("Edit card");
    expect(html).toContain("Approve — make ready");
    expect(html).toContain("Pull the week&#x27;s threads.");
  });

  it("is read-only when the project is archived", () => {
    const html = renderToStaticMarkup(
      <CardDetailView slug="s" card={DETAIL} profiles={[]} archived />,
    );
    expect(html).not.toContain('data-component="CardEditor"');
    expect(html).not.toContain('data-component="CardActions"');
  });

  // Regression: a blocked card used to show status="blocked" and nothing
  // else — no reason, no next step (kanban_block's `reason` is required at
  // the tool layer but the card detail endpoint dropped it before it ever
  // reached the UI; see the projects_api.py get_card() fix).
  it("surfaces why a blocked card stopped and what to do next", () => {
    const html = renderToStaticMarkup(
      <CardDetailView
        slug="s"
        card={{
          ...CARD({
            status: "blocked",
            block_kind: "needs_input",
            latest_summary: "Which Canva template should I use?",
          }),
          age: null,
        }}
        profiles={["default"]}
      />,
    );
    expect(html).toContain('data-component="CardBlockedReason"');
    expect(html).toContain("Needs your input");
    expect(html).toContain("Which Canva template should I use?");
    expect(html).toContain("Make ready");
    // Not repeated in a second, generically-labelled section.
    expect(html).not.toContain('data-component="CardResult"');
  });

  it("still shows a blocked banner when no reason was recorded", () => {
    const html = renderToStaticMarkup(
      <CardDetailView
        slug="s"
        card={{ ...CARD({ status: "blocked" }), age: null }}
        profiles={[]}
      />,
    );
    expect(html).toContain('data-component="CardBlockedReason"');
    expect(html).toContain("No reason was recorded for this block.");
  });

  // The card carries the tool surface its worker was spawned with —
  // stamped at creation (step's toolsets ∩ profile-enabled ∪ floor).
  // Users must be able to see why a worker could (or couldn't) use a
  // given tool, so a narrowed card names its sets and an unstamped one
  // says it loads the profile's full surface.
  it("names the narrowed tool surface stamped on the card", () => {
    const html = renderToStaticMarkup(
      <CardDetailView
        slug="s"
        card={{
          ...CARD({ status: "running" }),
          toolsets: ["file", "terminal", "kanban"],
          age: null,
        }}
        profiles={[]}
      />,
    );
    expect(html).toContain("worker tools: file, terminal, kanban");
  });

  it("says an unstamped card loads the profile's full tool surface", () => {
    const html = renderToStaticMarkup(
      <CardDetailView
        slug="s"
        card={{ ...CARD({ status: "running" }), age: null }}
        profiles={[]}
      />,
    );
    expect(html).toContain("worker tools: full profile surface");
  });
});

describe("CardActions", () => {
  it("offers Stop and Re-run for a running card", () => {
    const html = renderToStaticMarkup(
      <CardActions slug="s" taskId="t_1" status="running" />,
    );
    expect(html).toContain("Stop");
    expect(html).toContain("Re-run");
  });

  it("offers Make ready (not a reclaim) and no Stop for a blocked card", () => {
    const html = renderToStaticMarkup(
      <CardActions slug="s" taskId="t_1" status="blocked" />,
    );
    expect(html).toContain("Make ready");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Re-run");
    expect(html).not.toContain(">Stop<");
  });

  it("offers Stop but no Re-run for an unclaimed ready card", () => {
    const html = renderToStaticMarkup(
      <CardActions slug="s" taskId="t_1" status="ready" />,
    );
    expect(html).toContain("Stop");
    expect(html).not.toContain("Re-run");
  });

  it("renders nothing for settled cards", () => {
    const html = renderToStaticMarkup(
      <CardActions slug="s" taskId="t_1" status="done" />,
    );
    expect(html).toBe("");
  });
});

describe("FilesPanel", () => {
  it("renders file rows as clickable open buttons", () => {
    const html = renderToStaticMarkup(
      <FilesPanel
        project={{
          ...PROJECT,
          links: {
            file: [
              LINK({
                kind: "file",
                ref: "leo_owner/proj/fde2b2b6-2131-4abc-9def-0123456789ab-Lesson_Plan.pdf",
                label: null,
              }),
            ],
          },
        }}
      />,
    );
    expect(html).toContain('aria-label="Open Lesson Plan.pdf"');
    expect(html).toContain("<button");
  });
});

describe("RunView", () => {
  const RUN: ProjectRun = {
    id: "run_14",
    project_id: "prj_1",
    run_no: 14,
    trigger: "schedule",
    triggered_by: null,
    profile: "default",
    playbook_rev: 3,
    status: "waiting",
    started_at: NOW - 7_200,
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
    cards: [{ task_id: "task_2", step_key: "draft", status: "running", title: "Draft the digest" }],
    cost: 0.42,
    cost_recorded: true,
    duration_seconds: 1_200,
    deliveries: [
      {
        id: "del_1",
        output_id: "out_1",
        run_id: "run_14",
        task_id: null,
        link_kind: "file",
        link_ref: "digest.md",
        profile: "default",
        label: "digest.md",
        note: null,
        delivered_at: NOW - 3_600,
      },
    ],
  };

  it("shows timing, cost, cards and deliveries", () => {
    const html = renderToStaticMarkup(<RunView slug="monday-digest" run={RUN} />);
    expect(html).toContain("Run #14");
    expect(html).toContain("$0.42");
    expect(html).toContain("/projects/monday-digest/cards/task_2");
    expect(html).toContain("digest.md");
    // A waiting run offers Continue; cancel stays available while live.
    expect(html).toContain("Continue");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Repeat this run");
  });

  it("flags unrecorded cost and offers repeat once the run closed", () => {
    const html = renderToStaticMarkup(
      <RunView slug="monday-digest" run={{ ...RUN, status: "done", cost: null, cost_recorded: false, ended_at: NOW }} />,
    );
    expect(html).toContain("not recorded");
    expect(html).toContain("Repeat this run");
    expect(html).not.toContain("Cancel");
  });
});

describe("CardDetailView", () => {
  it("renders the board row with its timing and worker summary", () => {
    const html = renderToStaticMarkup(
      <CardDetailView
        slug="monday-digest"
        card={{
          ...CARD({ body: "Write the thing.", result: "Done — sent to the channel." }),
          age: { created_age_seconds: 86_400, started_age_seconds: 3_600, time_to_complete_seconds: null },
          latest_summary: null,
        }}
      />,
    );
    expect(html).toContain("Draft the digest");
    expect(html).toContain("Write the thing.");
    expect(html).toContain("Done — sent to the channel.");
    expect(html).toContain("/projects/monday-digest");
  });
});

describe("AddToProjectSheet", () => {
  it("offers only linking when there is nothing to promote", () => {
    const html = renderToStaticMarkup(
      <AddToProjectSheet onClose={() => {}} fixedSlug="monday-digest" fixedName="Digest" />,
    );
    expect(html).toContain("Add link");
    expect(html).not.toContain("Promote to card");
  });

  it("offers promotion alongside linking for a to-do (§10)", () => {
    const html = renderToStaticMarkup(
      <AddToProjectSheet
        onClose={() => {}}
        prefill={{ kind: "todo", ref: "td_1", label: "Draft the plan" }}
        promote={{ todoId: "td_1", todoTitle: "Draft the plan" }}
      />,
    );
    expect(html).toContain("Promote to card");
    expect(html).toContain("Add link");
    // The one line of copy that states the difference (§13).
    expect(html).toContain("moves the");
    expect(html).toContain("to-do to working");
  });
});

// The boundary test is the production guard: every new module under
// src/components/projects must be listed — extend it when adding files.
describe("boundary expectations", () => {
  it("keeps filters.ts + format.ts server-safe by construction", async () => {
    // Importing without a DOM would throw if either module were "use client"
    // with client-only side effects at module scope.
    const filters = await import("@/components/projects/filters");
    const format = await import("@/components/projects/format");
    expect(filters.DEFAULT_VIEW).toBe("active");
    expect(format.dayDistance(NOW + 3_600)).toBe("today");
  });
});

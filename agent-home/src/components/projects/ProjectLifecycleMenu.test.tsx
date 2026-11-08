import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The menu uses next/navigation — stub the router hook so SSR rendering works.
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
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
    { project_id: "prj_1", user_id: "mia_member", role: "member", added_by: null, added_at: NOW },
    { project_id: "prj_1", user_id: "sam_viewer", role: "viewer", added_by: null, added_at: NOW },
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

const MENU = (project: ProjectDetail, callerUserId: string, isInstanceAdmin = false) =>
  renderToStaticMarkup(
    <ProjectLifecycleMenu
      project={project}
      callerUserId={callerUserId}
      isInstanceAdmin={isInstanceAdmin}
    />,
  );

describe("ProjectLifecycleMenu", () => {
  it("renders nothing for a viewer", () => {
    expect(MENU(PROJECT({}), "sam_viewer")).toBe("");
  });

  it("renders nothing for a shared-read principal with no member row", () => {
    expect(MENU(PROJECT({}), "ghost")).toBe("");
  });

  it("shows Archive disabled with the reason for a member who is not a lead", () => {
    const html = MENU(PROJECT({}), "mia_member");
    expect(html).toContain("Archive project");
    // `disabled=""` — the attribute, not the `disabled:*` Tailwind classes.
    expect(html).toContain('disabled=""');
    expect(html).toContain("Only a lead can change this project");
    expect(html).not.toContain("Delete permanently");
  });

  it("offers Archive but never Delete on a live project for a lead", () => {
    const html = MENU(PROJECT({}), "leo_owner");
    expect(html).toContain("Archive project");
    expect(html).not.toContain("Restore project");
    expect(html).not.toContain("Delete permanently");
    expect(html).not.toContain('disabled=""');
  });

  it("a lead member row (not the owner) also leads", () => {
    const html = MENU(
      PROJECT({
        members: [
          { project_id: "prj_1", user_id: "lena_lead", role: "lead", added_by: null, added_at: NOW },
        ],
      }),
      "lena_lead",
    );
    expect(html).toContain("Archive project");
    expect(html).not.toContain("Only a lead can change this project");
  });

  it("an instance admin leads even without a member row", () => {
    const html = MENU(PROJECT({}), "root_admin", true);
    expect(html).toContain("Archive project");
  });

  it("offers Restore and Delete on an archived, genuinely empty project", () => {
    const html = MENU(PROJECT({ archived: true, status: "archived" }), "leo_owner");
    expect(html).toContain("Restore project");
    expect(html).toContain("Delete permanently");
    expect(html).not.toContain("Archive project");
  });

  it("withholds Delete once the project has runs", () => {
    const html = MENU(
      PROJECT({
        archived: true,
        status: "archived",
        runs: [
          {
            run_no: 1,
            status: "done",
            trigger: "manual",
            started_at: NOW - 3_600,
            ended_at: NOW - 1_800,
            duration_seconds: 1_800,
            outcome: null,
            score_user: null,
          },
        ],
      }),
      "leo_owner",
    );
    expect(html).toContain("Restore project");
    expect(html).not.toContain("Delete permanently");
  });

  it("withholds Delete once an output was delivered or accepted", () => {
    const html = MENU(
      PROJECT({
        archived: true,
        status: "archived",
        outputs: [
          {
            id: "out_1",
            project_id: "prj_1",
            seq: 1,
            title: "The digest itself",
            spec: null,
            kind: "artifact",
            required: 1,
            recurring: 0,
            status: "delivered",
            delivered_at: NOW,
            accepted_at: null,
            accepted_by: null,
            created_at: NOW,
            deliveries: [],
          },
        ],
      }),
      "leo_owner",
    );
    expect(html).toContain("Restore project");
    expect(html).not.toContain("Delete permanently");
  });

  it("U8: Delete reads the principal-blind total, not the caller-visible one", () => {
    // The caller sees zero cards (the other principal's card is invisible
    // to them) — the principal-blind total still says two, so no Delete.
    const html = MENU(
      PROJECT({
        archived: true,
        status: "archived",
        card_rollup: {
          total: 0,
          done: 0,
          running: 0,
          blocked: 0,
          total_with_archived: 0,
          total_all_principals: 2,
        },
      }),
      "leo_owner",
    );
    expect(html).toContain("Restore project");
    expect(html).not.toContain("Delete permanently");
  });

  it("U8: Delete returns once every principal's cards are gone", () => {
    const html = MENU(
      PROJECT({
        archived: true,
        status: "archived",
        card_rollup: {
          total: 0,
          done: 0,
          running: 0,
          blocked: 0,
          total_with_archived: 0,
          total_all_principals: 0,
        },
      }),
      "leo_owner",
    );
    expect(html).toContain("Delete permanently");
  });

  it("withholds Delete while the board still has cards", () => {
    const html = MENU(
      PROJECT({
        archived: true,
        status: "archived",
        card_rollup: { total: 2, done: 1, running: 0, blocked: 0 },
      }),
      "leo_owner",
    );
    expect(html).toContain("Restore project");
    expect(html).not.toContain("Delete permanently");
  });
});

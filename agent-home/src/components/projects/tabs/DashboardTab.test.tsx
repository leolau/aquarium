import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import {
  NOW,
  board,
  card,
  directive,
  playbook,
  project,
  run,
} from "@/components/projects/dashboard/__fixtures__/dashboard";
import { JourneyBar } from "@/components/projects/dashboard/JourneyBar";
import { nextAction } from "@/components/projects/dashboard/nextAction";
import { DashboardTab } from "@/components/projects/tabs/DashboardTab";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

vi.useFakeTimers();
vi.setSystemTime(NOW * 1000);

function render(over: Partial<ProjectTabProps>): string {
  const props: ProjectTabProps = {
    project: project(),
    board: board(),
    playbook: playbook(),
    directives: null,
    doctor: null,
    callerUserId: "yan",
    canLead: true,
    readiness: [],
    runnable: true,
    onNavigate: () => {},
    onChangeRequest: () => {},
    ...over,
  };
  // The page puts the one next action in the journey bar above the tab.
  const action = nextAction(props.project, props.board, props.readiness, props.playbook, NOW, props.canLead);
  return renderToStaticMarkup(
    <>
      <JourneyBar
        project={props.project}
        action={action}
        readiness={props.readiness}
        canLead={props.canLead}
        canAct={props.canLead}
        onNavigate={props.onNavigate}
        onReveal={() => {}}
        onChangeRequest={props.onChangeRequest}
      />
      <DashboardTab {...props} />
    </>,
  );
}

function stateOf(html: string, step: string): string | undefined {
  return html.match(new RegExp(`data-step="${step}" data-state="([a-z]+)"`))?.[1];
}

describe("DashboardTab", () => {
  it("working: nothing needed, run progress and the next checkpoint", () => {
    const html = render({
      project: project({ runs: [run({ run_no: 3, status: "running", ended_at: null })] }),
      board: board(card({ id: "a", status: "running" }), card({ id: "b", status: "done" })),
      playbook: playbook([
        { key: "a", title: "Draft" },
        { key: "b", title: "Review drafts", checkpoint: true },
      ]),
    });
    expect(html).toContain('data-state="working"');
    expect(html).toContain("Nothing needed from you right now");
    expect(html).not.toContain('data-needs-person="true"');
    expect(html).toContain("Watch run 3");
    expect(html).toContain("/projects/mou-set/runs/3");
    expect(html).toContain("Review drafts");
    expect(stateOf(html, "iteration")).toBe("current");
    expect(html).toContain("1 of 2 cards done");
    expect(html).toMatch(/data-component="NeedsYouCount"[^>]*>0</);
  });

  it("stalled: the hero asks to approve the agent's cards, never 'nothing needed'", () => {
    const html = render({
      project: project({ runs: [run({ run_no: 2, status: "running", started_at: NOW - 7_200, ended_at: null })] }),
      board: board(
        card({ id: "t1", status: "triage", title: "Produce four MOUs", created_by: "default" }),
        card({ id: "t2", status: "triage", title: "Re-verify clauses", created_by: "default" }),
        card({ id: "t3", status: "triage", title: "Upload v2 set", created_by: "default" }),
        card({ id: "d", status: "done" }),
      ),
    });
    expect(html).toContain('data-state="stalled"');
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('data-needs-person="true"');
    expect(html).toContain("Approve 3 cards &amp; resume work");
    expect(html).toContain("Run 2 stalled");
    expect(html).not.toContain("Nothing needed");
    expect(stateOf(html, "iteration")).toBe("attention");
    // Both the stall and the approval are listed; the approval points up.
    expect(html).toContain('data-needs-you="run:stalled:2"');
    expect(html).toContain('data-needs-you="triage"');
    expect(html).toContain("↑ above");
    expect(html).toMatch(/data-component="NeedsYouCount"[^>]*>2</);
  });

  it("idle: start the next iteration or say what to change", () => {
    const html = render({
      project: project({ runs: [run({ run_no: 1 }), run({ run_no: 2 })] }),
      directives: {
        applies_from: "next_run",
        directives: [directive({ id: "d1", body: "3-year term", author_user_id: "leo", created_at: NOW - 3_600 })],
      },
    });
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("Start the next iteration");
    expect(html).toContain("Start iteration 3");
    expect(html).toContain("Starts run 3 with plan rev 3.");
    expect(html).toContain("Tell the agent what to change");
    expect(html).toContain("Nothing right now. The agent has it.");
    // Requirements: v2, newest change highlighted with who.
    expect(html).toMatch(/data-component="RequirementsVersion"[^>]*>v2</);
    expect(html).toMatch(/data-new="true"[^>]*>[\s\S]*3-year term[\s\S]*leo/);
    expect(html).toContain("History ›");
    // Activity from the run brief.
    expect(html).toContain("Run 2 finished");
  });

  it("brand-new: no inputs and unmet readiness are listed, ranked", () => {
    const html = render({
      project: project({ outputs: [], links: {}, status: "planning" }),
      playbook: null,
      readiness: [
        { key: "outputs", label: "At least one output", ok: false, hint: "Declare what the project delivers.", anchor: "?tab=outputs", tab: "outputs" },
        { key: "status", label: "Project activated", ok: false, hint: "Activate it", anchor: "#project-header" },
      ],
    });
    expect(html).toContain('data-needs-person="true"');
    expect(html).toContain("No inputs attached");
    expect(html.indexOf('data-needs-you="inputs"')).toBeLessThan(html.indexOf('data-needs-you="readiness:outputs"'));
    expect(html).toMatch(/data-component="NeedsYouCount"[^>]*>2</);
    expect(stateOf(html, "brief")).toBe("attention");
    expect(stateOf(html, "plan")).toBe("attention");
    expect(html).toContain("No outputs declared yet");
    expect(html).toContain("Nothing has happened yet.");
  });

  it("lays out two columns from md: needs-you left, where-it-stands right", () => {
    const html = render({});
    expect(html).toContain("md:grid-cols-2");
    const left = html.indexOf('data-column="left"');
    const right = html.indexOf('data-column="right"');
    expect(html.indexOf('data-component="JourneyBar"')).toBeLessThan(left);
    expect(html).not.toContain('data-component="NextActionHero"');
    expect(html.indexOf('data-component="NeedsYou"')).toBeLessThan(right);
    expect(right).toBeLessThan(html.indexOf('data-component="WhereItStands"'));
    expect(html.indexOf('data-component="WhereItStands"')).toBeLessThan(html.indexOf('data-component="CurrentRequirements"'));
    expect(html.indexOf('data-component="CurrentRequirements"')).toBeLessThan(html.indexOf('data-component="DashboardActivity"'));
  });
});

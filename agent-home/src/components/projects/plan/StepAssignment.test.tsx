import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AssignmentDetails,
  WhoDoesWhat,
  assignmentForSave,
  assignmentOf,
  hasAssignment,
  trackRecordText,
  whoDoesWhat,
} from "@/components/projects/plan/StepAssignment";
import type { PlaybookStep } from "@/types";

const STEPS: PlaybookStep[] = [
  { key: "a", title: "Collect pricing", assignee: "researcher", fit: "strong", assigned_by: "planner" },
  { key: "b", title: "More pricing", assignee: "researcher", fit: "partial", assigned_by: "planner" },
  { key: "c", title: "Draft report", assignee: "writer", fit: "strong", assigned_by: "planner" },
  { key: "d", title: "Email client", assignee: null, fit: "none", assigned_by: "fallback" },
];

describe("hasAssignment", () => {
  it("is false for steps written before assignment reasons existed", () => {
    expect(hasAssignment({ key: "x", title: "x", assignee: "default" } as PlaybookStep)).toBe(false);
    expect(hasAssignment(null)).toBe(false);
    expect(hasAssignment({ matched_skills: [] })).toBe(false);
  });

  it("is true once any C-3 field is present", () => {
    expect(hasAssignment({ fit: "partial" })).toBe(true);
    expect(hasAssignment({ assigned_by: "manual" })).toBe(true);
    expect(hasAssignment({ assignee_reason: "has docx" })).toBe(true);
  });
});

describe("whoDoesWhat", () => {
  it("counts every step once, sends unassigned steps to the host, counts no-fit steps", () => {
    const { rows, noFit } = whoDoesWhat(STEPS, "default");
    expect(rows.reduce((n, r) => n + r.steps, 0)).toBe(STEPS.length);
    expect(rows).toEqual([
      { profile: "researcher", steps: 2 },
      { profile: "writer", steps: 1 },
      { profile: "default", steps: 1 },
    ]);
    expect(noFit).toBe(STEPS.filter((s) => s.fit === "none").length);
  });

  it("renders the summary only for plans that carry assignment fields", () => {
    const html = renderToStaticMarkup(<WhoDoesWhat steps={STEPS} hostProfile="default" />);
    expect(html).toContain("Who does what");
    expect(html).toContain("researcher: 2 steps");
    expect(html).toContain("default (host): 1 step");
    expect(html).toContain("1 step with no good fit");
    const old = renderToStaticMarkup(
      <WhoDoesWhat steps={[{ key: "a", title: "A", assignee: "default" }]} />,
    );
    expect(old).toBe("");
  });
});

describe("assignmentForSave", () => {
  const planner = { assignee_reason: "has docx", fit: "strong" as const, matched_skills: ["docx"], assigned_by: "planner" as const };

  it("keeps the planner's fields when the assignee is unchanged", () => {
    expect(assignmentForSave(planner, "writer", "writer")).toEqual(planner);
  });

  it("marks a changed assignee manual, drops the stale reason, keeps the planner's pick", () => {
    const out = assignmentForSave(planner, "writer", "researcher");
    expect(out).toEqual({ assigned_by: "manual", planner_assignee: "writer" });
  });

  it("keeps the original planner pick across repeated hand edits", () => {
    const out = assignmentForSave({ assigned_by: "manual", planner_assignee: "writer" }, "researcher", "default");
    expect(out.planner_assignee).toBe("writer");
  });

  it("adds nothing for an untouched older step", () => {
    expect(assignmentForSave(assignmentOf({ key: "a", title: "A", assignee: "x" }), "x", "x")).toEqual({});
  });
});

describe("AssignmentDetails", () => {
  it("shows chip, fit, reason and matched skills", () => {
    const html = renderToStaticMarkup(
      <AssignmentDetails
        assignee="researcher"
        assignment={{ fit: "strong", assignee_reason: "Has web-research; finished 14 of 15 research cards.", matched_skills: ["web-research", "citation"], assigned_by: "planner" }}
      />,
    );
    expect(html).toContain('data-component="ProfileChip"');
    expect(html).toContain("researcher");
    expect(html).toContain('data-fit="strong"');
    expect(html).toContain("strong fit");
    expect(html).toContain("finished 14 of 15");
    expect(html).toContain("web-research");
    expect(html).toContain("citation");
    expect(html).not.toContain("NoFitWarning");
    expect(html).not.toContain("changed by you");
  });

  it("warns on no fit, with the suggested profile when given", () => {
    const html = renderToStaticMarkup(
      <AssignmentDetails assignee={null} hostProfile="default" assignment={{ fit: "none", assigned_by: "fallback", suggested_profile: "mailer" }} />,
    );
    expect(html).toContain('data-component="NoFitWarning"');
    expect(html).toContain("No profile fits this step well.");
    expect(html).toContain("“mailer”");
    expect(html).toContain(">default<");
    const bare = renderToStaticMarkup(
      <AssignmentDetails assignee="default" assignment={{ fit: "none" }} />,
    );
    expect(bare).toContain("No profile fits this step well.");
    expect(bare).not.toContain("Consider adding");
  });

  it("marks a hand-picked assignee and hints at an undescribed profile", () => {
    const html = renderToStaticMarkup(
      <AssignmentDetails
        assignee="writer"
        assignment={{ assigned_by: "manual", planner_assignee: "researcher" }}
        profile={{ name: "writer", description: "" }}
      />,
    );
    expect(html).toContain("changed by you");
    expect(html).toContain("planner picked researcher");
    expect(html).toContain('data-component="NoDescriptionHint"');
    const described = renderToStaticMarkup(
      <AssignmentDetails assignee="writer" assignment={{ assigned_by: "manual" }} profile={{ name: "writer", description: "Writes reports." }} />,
    );
    expect(described).not.toContain("NoDescriptionHint");
  });

  it("renders nothing without assignment fields", () => {
    expect(renderToStaticMarkup(<AssignmentDetails assignee="x" assignment={{}} />)).toBe("");
  });
});

describe("trackRecordText", () => {
  it("summarises completed / blocked / failed and tolerates missing data", () => {
    expect(trackRecordText({ name: "r", track_record: { window_days: 90, completed: 14, blocked: 1, failed: 0 } })).toBe(
      "14 completed · 1 blocked · 0 failed (90 days)",
    );
    expect(trackRecordText({ name: "r", track_record: { completed: 0 } })).toBe("no cards run yet");
    expect(trackRecordText({ name: "r" })).toBeNull();
  });
});

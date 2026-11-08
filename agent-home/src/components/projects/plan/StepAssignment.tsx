"use client";

import { useEffect, useState } from "react";

import { Pill, type Tone } from "@/components/ui/Pill";
import type {
  AssignableProfile,
  AssignableProfilesResponse,
  AssignmentFit,
  PlaybookStep,
  ProfileCapabilityCard,
  StepAssignment,
} from "@/types";

/** The FG-34 C-3 fields a plan step or run card may carry. */
export const ASSIGNMENT_FIELDS = [
  "assignee_reason",
  "fit",
  "matched_skills",
  "assigned_by",
  "suggested_profile",
  "planner_assignee",
] as const;

const FIT_LABEL: Record<AssignmentFit, string> = {
  strong: "strong fit",
  partial: "partial fit",
  none: "no good fit",
};

const FIT_TONE: Record<AssignmentFit, Tone> = {
  strong: "success",
  partial: "warning",
  none: "danger",
};

/** True when the step/card says anything about why it got its profile. */
export function hasAssignment(a: StepAssignment | null | undefined): boolean {
  if (!a) return false;
  return Boolean(
    (a.assignee_reason && a.assignee_reason.trim()) ||
      (a.fit && a.fit in FIT_LABEL) ||
      a.assigned_by ||
      (a.matched_skills && a.matched_skills.length > 0) ||
      a.suggested_profile,
  );
}

/** Only the C-3 fields of a step, for carrying them through an edit. */
export function assignmentOf(step: PlaybookStep | StepAssignment): StepAssignment {
  const out: Record<string, unknown> = {};
  for (const field of ASSIGNMENT_FIELDS) {
    const value = (step as Record<string, unknown>)[field];
    if (value !== undefined && value !== null) out[field] = value;
  }
  return out as StepAssignment;
}

/**
 * The C-3 fields to save for a step after the editor: unchanged picks keep
 * what the planner wrote; any change of assignee is the person's choice, so
 * it is marked `manual` and the planner's own pick is kept for reference.
 */
export function assignmentForSave(
  original: StepAssignment | null,
  originalAssignee: string,
  assignee: string,
): StepAssignment {
  const fields = original ?? {};
  if (assignee === originalAssignee) return fields;
  const plannerPick =
    fields.planner_assignee ??
    (fields.assigned_by && fields.assigned_by !== "manual" ? originalAssignee || null : null);
  return plannerPick
    ? { assigned_by: "manual", planner_assignee: plannerPick }
    : { assigned_by: "manual" };
}

/** Who a step goes to: its assignee, else the host profile it falls back to. */
function stepProfile(assignee: string | null | undefined, hostProfile?: string | null): string {
  return assignee || hostProfile || "any profile";
}

export interface WhoDoesWhatRow {
  profile: string;
  steps: number;
}

/** Steps per profile (in first-seen order) and how many have no good fit. */
export function whoDoesWhat(
  steps: PlaybookStep[],
  hostProfile?: string | null,
): { rows: WhoDoesWhatRow[]; noFit: number } {
  const counts = new Map<string, number>();
  let noFit = 0;
  for (const step of steps) {
    const profile = stepProfile(step.assignee, hostProfile);
    counts.set(profile, (counts.get(profile) ?? 0) + 1);
    if (step.fit === "none") noFit += 1;
  }
  return {
    rows: Array.from(counts, ([profile, n]) => ({ profile, steps: n })),
    noFit,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * "Who does what" above a plan's steps. Renders nothing for plans written
 * before steps carried an assignment reason, so those look as they always did.
 */
export function WhoDoesWhat({
  steps,
  hostProfile,
}: {
  steps: PlaybookStep[];
  hostProfile?: string | null;
}) {
  if (!steps.some((s) => hasAssignment(s))) return null;
  const { rows, noFit } = whoDoesWhat(steps, hostProfile);
  return (
    <p
      data-component="WhoDoesWhat"
      className="mt-2 text-xs text-[var(--color-muted)]"
    >
      <span className="font-medium text-[var(--color-fg)]">Who does what</span>
      {" — "}
      {rows
        .map(
          (r) =>
            `${r.profile}${hostProfile && r.profile === hostProfile ? " (host)" : ""}: ${plural(r.steps, "step")}`,
        )
        .join(" · ")}
      {noFit > 0 ? (
        <span data-component="WhoDoesWhatNoFit" className="text-[var(--color-danger)]">
          {` · ${plural(noFit, "step")} with no good fit`}
        </span>
      ) : null}
    </p>
  );
}

/**
 * Why one step (or card) went to its profile: chip, fit, the planner's
 * sentence and the skills it matched; a warning when nothing fits, a
 * marker when a person changed it, a hint when the profile is undescribed.
 */
export function AssignmentDetails({
  assignment,
  assignee,
  hostProfile,
  profile,
}: {
  assignment: StepAssignment;
  assignee: string | null | undefined;
  hostProfile?: string | null;
  /** The chosen profile's card, when loaded — only used for the description hint. */
  profile?: ProfileCapabilityCard | null;
}) {
  if (!hasAssignment(assignment)) return null;
  const fit = assignment.fit && assignment.fit in FIT_LABEL ? assignment.fit : null;
  const skills = (assignment.matched_skills ?? []).filter(Boolean);
  const reason = assignment.assignee_reason?.trim();
  const manual = assignment.assigned_by === "manual";
  const name = stepProfile(assignee, hostProfile);
  return (
    <div data-component="StepAssignment" className="mt-1 flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          data-component="ProfileChip"
          className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5"
        >
          {name}
        </span>
        {fit ? (
          <span data-component="FitBadge" data-fit={fit}>
            <Pill tone={FIT_TONE[fit]}>{FIT_LABEL[fit]}</Pill>
          </span>
        ) : null}
        {manual ? (
          <span data-component="ChangedByYou" className="text-[var(--color-muted)]">
            changed by you
            {assignment.planner_assignee && assignment.planner_assignee !== assignee
              ? ` (planner picked ${assignment.planner_assignee})`
              : ""}
          </span>
        ) : null}
      </div>
      {reason ? (
        <p data-component="AssigneeReason" className="text-[var(--color-muted)]">
          {reason}
        </p>
      ) : null}
      {skills.length > 0 ? (
        <div data-component="MatchedSkills" className="flex flex-wrap gap-1">
          {skills.map((skill) => (
            <span
              key={skill}
              className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-muted)]"
            >
              {skill}
            </span>
          ))}
        </div>
      ) : null}
      {fit === "none" ? (
        <p
          data-component="NoFitWarning"
          role="note"
          className="rounded-md bg-amber-500/10 px-2 py-1 text-[var(--color-warn-text)]"
        >
          No profile fits this step well.
          {assignment.suggested_profile
            ? ` Consider adding a “${assignment.suggested_profile}” profile.`
            : ""}
        </p>
      ) : null}
      {profile && !profile.description?.trim() ? (
        <p data-component="NoDescriptionHint" className="text-[var(--color-muted)]">
          {profile.name} has no description, so the planner can only go by its name.
        </p>
      ) : null}
    </div>
  );
}

/** `14 completed · 1 blocked · 0 failed (90 days)`, or null with no record. */
export function trackRecordText(card: ProfileCapabilityCard): string | null {
  const tr = card.track_record;
  if (!tr) return null;
  const completed = tr.completed ?? 0;
  const blocked = tr.blocked ?? 0;
  const failed = tr.failed ?? 0;
  if (completed + blocked + failed === 0) return "no cards run yet";
  const window = tr.window_days ? ` (${tr.window_days} days)` : "";
  return `${completed} completed · ${blocked} blocked · ${failed} failed${window}`;
}

/** The first few skill names, for a one-line summary. */
export function topSkills(card: ProfileCapabilityCard, max = 5): string[] {
  return (card.skills ?? []).map((s) => s.name).filter(Boolean).slice(0, max);
}

/** What the step editor shows under the assignee picker for the chosen profile. */
export function ProfileFacts({ profile }: { profile: AssignableProfile }) {
  const skills = topSkills(profile);
  const record = trackRecordText(profile);
  return (
    <div
      data-component="ProfileFacts"
      className="flex w-full flex-col gap-0.5 text-xs text-[var(--color-muted)]"
    >
      <p>{profile.description?.trim() || "No description yet."}</p>
      {skills.length > 0 ? <p>Skills: {skills.join(", ")}</p> : null}
      {record ? <p>Track record: {record}</p> : null}
      {!profile.in_project ? (
        <p data-component="NotInProject" className="text-[var(--color-warn-text)]">
          Not in this project yet — will be added when the plan is approved.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The profiles a step may go to (FG-34 C-2), loaded once `enabled`. `null`
 * while loading or when the route is unavailable — callers fall back to
 * the project's own profile names.
 */
export function useAssignableProfiles(
  slug: string,
  enabled: boolean,
): AssignableProfile[] | null {
  const [profiles, setProfiles] = useState<AssignableProfile[] | null>(null);
  useEffect(() => {
    if (!enabled || profiles != null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(slug)}/assignable-profiles`,
        );
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as AssignableProfilesResponse | null;
        if (!cancelled && data && Array.isArray(data.profiles)) {
          setProfiles(data.profiles.filter((p) => p && typeof p.name === "string"));
        }
      } catch {
        // Unavailable: the picker keeps the project's profile names.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, enabled, profiles]);
  return profiles;
}

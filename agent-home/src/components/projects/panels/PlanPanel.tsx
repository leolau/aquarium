"use client";

import { useCallback, useEffect, useState } from "react";
import { friendlyError } from "@/components/projects/errors";

import { BusyRegion } from "@/components/ui/BusyRegion";
import { useRefresh } from "@/components/ui/useRefresh";
import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type {
  PlaybookRev,
  PlaybookStep,
  ProjectPlaybookDraftState,
  ProjectPlaybookResponse,
} from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

/** How often the panel asks the server whether the agent's draft is ready. */
export const DRAFT_POLL_MS = 2_000;

interface StepDraft {
  title: string;
  assignee: string;
  after: string;
  checkpoint: boolean;
}

const EMPTY_STEP: StepDraft = { title: "", assignee: "", after: "", checkpoint: false };

/** `Send the Monday digest` → `send-the-monday-digest`; unique within the list. */
export function stepKey(title: string, index: number, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `step-${index + 1}`;
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  taken.add(key);
  return key;
}

function stepsToPayload(drafts: StepDraft[]): PlaybookStep[] {
  const taken = new Set<string>();
  const keyed = drafts
    .filter((d) => d.title.trim())
    .map((d, i) => ({ draft: d, key: stepKey(d.title.trim(), i, taken) }));
  const byTitle = new Map(keyed.map((k) => [k.draft.title.trim(), k.key]));
  return keyed.map(({ draft, key }) => ({
    key,
    title: draft.title.trim(),
    assignee: draft.assignee || null,
    depends_on: draft.after && byTitle.has(draft.after) ? [byTitle.get(draft.after)!] : [],
    checkpoint: draft.checkpoint,
  }));
}

/**
 * Inactive revisions split by where they sit relative to the active one.
 * Only a revision written *after* the active plan is a pending proposal;
 * an older one is history (it was superseded, or never picked), so it must
 * not reappear as "awaiting a decision" every time another rev is activated.
 */
export function splitRevisions(playbook: ProjectPlaybookResponse | null): {
  proposed: PlaybookRev[];
  earlier: PlaybookRev[];
} {
  const inactive = (playbook?.revisions ?? []).filter((rev) => !rev.active);
  const activeRev = playbook?.active?.rev;
  if (activeRev == null) return { proposed: inactive, earlier: [] };
  return {
    proposed: inactive.filter((rev) => rev.rev > activeRev),
    earlier: inactive.filter((rev) => rev.rev < activeRev),
  };
}

function draftsFromRev(rev: PlaybookRev | null): StepDraft[] {
  const steps = rev?.steps ?? [];
  if (steps.length === 0) return [{ ...EMPTY_STEP }];
  const titleByKey = new Map(steps.map((s) => [s.key, s.title]));
  return steps.map((s) => ({
    title: s.title,
    assignee: s.assignee ?? "",
    after: titleByKey.get((s.depends_on ?? s.needs ?? [])[0] ?? "") ?? "",
    checkpoint: Boolean(s.checkpoint),
  }));
}

/**
 * The active playbook, labelled **Plan** — "playbook" is our word, not the
 * user's (§13). Prose plus steps as an indented list, its revision and who
 * activated it. Proposed revisions (§8.2 — a retro's write-back, a draft
 * saved here, or one the agent drafted on request) render beneath with the
 * lead's Activate; saving is open to any member, activation stays a human
 * lead/admin act (§7.2).
 *
 * "Draft with the agent" starts a server-side job (`POST …/playbook/draft`)
 * and polls until the proposal lands — nothing enters the user's chat, and
 * a reload while it runs resumes the wait.
 */
export function PlanPanel({
  slug,
  playbook,
  profiles,
  canActivate,
  archived,
}: {
  slug: string;
  playbook: ProjectPlaybookResponse | null;
  /** The project's profiles — the only legal step assignees. */
  profiles: string[];
  canActivate: boolean;
  archived: boolean;
}) {
  const timeLabel = useTimeLabel();
  const { refresh } = useRefresh();
  const active = playbook?.active ?? null;
  const { proposed, earlier } = splitRevisions(playbook);

  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([{ ...EMPTY_STEP }]);
  const saveAction = useProjectAction();
  const busy = saveAction.busy;
  const draftAction = useProjectAction<ProjectPlaybookDraftState>();
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [activatedRev, setActivatedRev] = useState<number | null>(null);
  // A proposed revision is a pending decision — the only moves are
  // Activate or Discard. Starting another draft/write on top of it would
  // just stack more undecided revisions.
  const awaitingDecision = !editing && proposed.length > 0;

  const slugPath = `/api/projects/${encodeURIComponent(slug)}`;

  const settleDraft = useCallback(
    (state: ProjectPlaybookDraftState) => {
      if (state.status === "running") {
        setDrafting(true);
        return;
      }
      setDrafting(false);
      if (state.status === "done") {
        setDraftNotice(
          `The agent proposed revision ${state.rev ?? ""} — review it below and activate it when it looks right.`,
        );
        refresh();
      } else if (state.status === "failed") {
        setError(
          friendlyError(
            { status: 502, detail: state.detail },
            "The agent could not draft a plan — try again, or write it yourself.",
          ),
        );
      }
    },
    [refresh],
  );

  // On mount: resume waiting on a draft started before a reload. While
  // drafting: poll until the job settles. Both use the same GET.
  const unavailable = playbook == null;
  useEffect(() => {
    if (archived || unavailable) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch(`${slugPath}/playbook/draft`);
        const state = (await res.json().catch(() => ({}))) as ProjectPlaybookDraftState;
        if (cancelled) return;
        if (!res.ok || !state.status) {
          setDrafting(false);
          return;
        }
        if (state.status === "running") {
          setDrafting(true);
          timer = setTimeout(() => void poll(), DRAFT_POLL_MS);
          return;
        }
        // A finished job seen on first mount is old news; only report the
        // outcome of a draft this panel was waiting on.
        if (drafting) settleDraft(state);
      } catch {
        if (cancelled) return;
        setDrafting(false);
        if (drafting) setError("Could not reach the server.");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [archived, unavailable, slugPath, drafting, settleDraft]);

  const draftWithAgent = () => {
    setActivatedRev(null);
    setError(null);
    setDraftNotice(null);
    void draftAction.run(`${slugPath}/playbook/draft`, {
      body: {},
      skipRefresh: true,
      onSuccess: (data) => settleDraft(data),
    });
  };

  const openEditor = (from: PlaybookRev | null) => {
    setActivatedRev(null);
    setBody(from?.body ?? "");
    setSteps(draftsFromRev(from));
    setError(null);
    saveAction.clearError();
    setEditing(true);
  };

  const save = () => {
    const payload = stepsToPayload(steps);
    if (payload.length === 0) {
      setError("A plan needs at least one step with a title.");
      return;
    }
    setError(null);
    void saveAction.run(`${slugPath}/playbook`, {
      body: { body: body.trim(), steps: payload },
      onSuccess: () => setEditing(false),
    });
  };

  const inputClass =
    "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";

  return (
    <section
      id="panel-plan"
      data-component="PlanPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Plan
        </h2>
        {!archived && !editing && playbook != null ? (
          <ActionButton
            data-component="DraftPlanWithAgent"
            busy={draftAction.busy}
            pendingLabel="Starting the draft…"
            onClick={draftWithAgent}
            disabled={drafting || awaitingDecision}
            title={
              awaitingDecision
                ? "A proposed revision is waiting — activate or discard it first."
                : undefined
            }
            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-50"
          >
            {drafting ? "Agent is drafting…" : "Draft with the agent"}
          </ActionButton>
        ) : null}
        {!archived && !editing ? (
          <button
            type="button"
            onClick={() => openEditor(active)}
            disabled={awaitingDecision}
            title={
              awaitingDecision
                ? "A proposed revision is waiting — activate or discard it first."
                : undefined
            }
            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-50"
          >
            {active ? "Revise" : "Write plan"}
          </button>
        ) : null}
      </div>

      {playbook == null ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The plan is unavailable right now.
        </p>
      ) : (
        <>
          {active == null && !editing && !drafting && proposed.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              No active plan yet — a run needs one. Ask the agent to draft one
              from the brief, or write it here; either way you activate it
              when it looks right.
            </p>
          ) : null}

          {drafting ? (
            <p
              data-component="DraftPlanProgress"
              role="status"
              className="mt-2 text-sm text-[var(--color-muted)]"
            >
              The agent is reading the brief and drafting steps — usually under
              a minute. It will appear below as a proposed revision; you can
              leave this page, the draft continues on the server.
            </p>
          ) : null}

          {activatedRev != null && active?.rev === activatedRev ? (
            <p
              data-component="PlanActivatedNotice"
              role="status"
              className="mt-2 text-sm text-[var(--color-accent)]"
            >
              Revision {activatedRev} is now the active plan — the next run uses it.
            </p>
          ) : null}

          {draftNotice ? (
            <p role="status" className="mt-2 text-sm text-[var(--color-accent)]">
              {draftNotice}
            </p>
          ) : null}

          {active != null ? (
            <>
              {active.body ? (
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  {active.body}
                </p>
              ) : null}
              {active.steps && active.steps.length > 0 ? (
                <ol className="mt-2 flex flex-col gap-1">
                  {active.steps.map((step, index) => (
                    <li
                      key={step.key}
                      className="flex items-baseline gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                      style={{
                        marginLeft: `${((step.depends_on ?? step.needs)?.length ?? 0) > 0 ? 1 : 0}rem`,
                      }}
                    >
                      <span className="text-xs text-[var(--color-muted)]">
                        {index + 1}.
                      </span>
                      <span className="min-w-0 flex-1">
                        {step.title}
                        {step.checkpoint ? (
                          <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-[var(--color-warn-text)]">
                            checkpoint
                          </span>
                        ) : null}
                        {step.assignee ? (
                          <span className="ml-2 text-xs text-[var(--color-muted)]">
                            → {step.assignee}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                revision {active.rev}
                {active.note ? ` · ${active.note}` : ""}
                {active.activated_at != null
                  ? ` · activated ${timeLabel(active.activated_at)}`
                  : ""}
                {active.created_by ? ` · by ${active.created_by}` : ""}
              </p>
            </>
          ) : null}

          {editing ? (
            <BusyRegion busy={busy} label="Saving the plan…">
              <form
                data-component="PlanEditor"
                className="mt-3 flex flex-col gap-3 rounded-xl border border-dashed border-[var(--color-border)] p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-[var(--color-muted)]">
                    How the agent should approach it (optional)
                  </span>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={3}
                    placeholder="Gather this week's arrivals, draft the digest, send it after a checkpoint…"
                    className={inputClass}
                  />
                </label>

                <div className="flex flex-col gap-2">
                  <span className="text-xs text-[var(--color-muted)]">
                    Steps — in order; each becomes a card on the board
                  </span>
                  {steps.map((step, index) => (
                    <div
                      key={index}
                      data-component="PlanStepRow"
                      className="flex flex-col gap-1.5 rounded-lg bg-[var(--color-surface-2)] p-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--color-muted)]">
                          {index + 1}.
                        </span>
                        <input
                          value={step.title}
                          onChange={(e) =>
                            setSteps((prev) =>
                              prev.map((s, i) =>
                                i === index ? { ...s, title: e.target.value } : s,
                              ),
                            )
                          }
                          placeholder="What this step delivers"
                          aria-label={`Step ${index + 1} title`}
                          className={inputClass}
                        />
                        {steps.length > 1 ? (
                          <button
                            type="button"
                            aria-label={`Remove step ${index + 1}`}
                            onClick={() =>
                              setSteps((prev) => prev.filter((_s, i) => i !== index))
                            }
                            className="rounded-lg border border-[var(--color-border)] px-2 text-sm text-[var(--color-muted)]"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 pl-5 text-xs">
                        <select
                          value={step.assignee}
                          onChange={(e) =>
                            setSteps((prev) =>
                              prev.map((s, i) =>
                                i === index ? { ...s, assignee: e.target.value } : s,
                              ),
                            )
                          }
                          aria-label={`Step ${index + 1} assignee`}
                          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
                        >
                          <option value="">any profile</option>
                          {profiles.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        {index > 0 ? (
                          <select
                            value={step.after}
                            onChange={(e) =>
                              setSteps((prev) =>
                                prev.map((s, i) =>
                                  i === index ? { ...s, after: e.target.value } : s,
                                ),
                              )
                            }
                            aria-label={`Step ${index + 1} waits for`}
                            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
                          >
                            <option value="">can start right away</option>
                            {steps
                              .slice(0, index)
                              .filter((s) => s.title.trim())
                              .map((s) => (
                                <option key={s.title} value={s.title.trim()}>
                                  after “{s.title.trim()}”
                                </option>
                              ))}
                          </select>
                        ) : null}
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={step.checkpoint}
                            onChange={(e) =>
                              setSteps((prev) =>
                                prev.map((s, i) =>
                                  i === index
                                    ? { ...s, checkpoint: e.target.checked }
                                    : s,
                                ),
                              )
                            }
                          />
                          pause for my approval after
                        </label>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSteps((prev) => [...prev, { ...EMPTY_STEP }])}
                    className="self-start rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs"
                  >
                    Add a step
                  </button>
                </div>

                <p className="text-xs text-[var(--color-muted)]">
                  Saving proposes a new revision; nothing changes until a lead
                  activates it.
                </p>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={busy}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <ActionButton
                    type="submit"
                    busy={busy}
                    pendingLabel="Saving…"
                    className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                  >
                    Save as revision
                  </ActionButton>
                </div>
              </form>
            </BusyRegion>
          ) : null}

          {proposed.length > 0 ? (
            <div className="mt-3" data-component="ProposedRevisions">
              <h3 className="text-xs font-medium text-[var(--color-muted)]">
                Proposed revisions — awaiting a decision
              </h3>
              <ul className="mt-1.5 flex flex-col gap-2">
                {proposed.map((rev) => (
                  <RevisionRow
                    key={rev.rev}
                    slug={slug}
                    rev={rev}
                    canActivate={canActivate}
                    archived={archived}
                    onActivated={setActivatedRev}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {earlier.length > 0 && !editing ? (
            <details className="mt-3" data-component="EarlierRevisions">
              <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted)]">
                Earlier revisions ({earlier.length}) — not in use
              </summary>
              <ul className="mt-1.5 flex flex-col gap-2">
                {earlier.map((rev) => (
                  <RevisionRow
                    key={rev.rev}
                    slug={slug}
                    rev={rev}
                    canActivate={canActivate}
                    archived={archived}
                    onActivated={setActivatedRev}
                    activateLabel="Switch back to this"
                  />
                ))}
              </ul>
            </details>
          ) : null}

          {error ? (
            <p role="alert" className="mt-2 text-sm text-red-400">
              {error}
            </p>
          ) : null}
          <ActionError action={saveAction} />
          <ActionError action={draftAction} />
        </>
      )}
    </section>
  );
}

/**
 * One inactive revision: its prose, steps and provenance, with the lead's
 * Discard + Activate (members see who decides instead).
 */
function RevisionRow({
  slug,
  rev,
  canActivate,
  archived,
  onActivated,
  activateLabel = "Activate",
}: {
  slug: string;
  rev: PlaybookRev;
  canActivate: boolean;
  archived: boolean;
  onActivated: (rev: number) => void;
  activateLabel?: string;
}) {
  return (
    <li className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm">
      {rev.body ? <p className="whitespace-pre-wrap">{rev.body}</p> : null}
      {(rev.steps ?? []).length > 0 ? (
        <ol className="mt-1 flex flex-col gap-0.5 text-xs">
          {(rev.steps ?? []).map((step, index) => (
            <li key={step.key}>
              {index + 1}. {step.title}
              {step.assignee ? ` → ${step.assignee}` : ""}
              {step.checkpoint ? " · checkpoint" : ""}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[var(--color-muted)]">no steps</p>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
          revision {rev.rev}
          {rev.note ? ` · ${rev.note}` : ""}
          {rev.created_by ? ` · by ${rev.created_by}` : ""}
        </p>
        {!archived && canActivate ? (
          <>
            <DiscardRevision slug={slug} rev={rev.rev} />
            <ActivateRevision
              slug={slug}
              rev={rev.rev}
              label={activateLabel}
              onActivated={onActivated}
            />
          </>
        ) : null}
        {!archived && !canActivate ? (
          <span className="text-xs text-[var(--color-muted)]">
            a lead activates or discards
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A lead's Discard on one proposed revision — "this draft is wrong",
 * the paired decision to Activate. Refused server-side when the rev is
 * active or a run pinned it (then the error surfaces inline).
 */
function DiscardRevision({ slug, rev }: { slug: string; rev: number }) {
  const action = useProjectAction();
  return (
    <>
      <ActionButton
        data-action="discard-revision"
        busy={action.busy}
        pendingLabel="Discarding…"
        onClick={() =>
          void action.run(
            `/api/projects/${encodeURIComponent(slug)}/playbook/${rev}`,
            { method: "DELETE" },
          )
        }
        className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-50"
      >
        Discard
      </ActionButton>
      <ActionError
        action={action}
        className="flex w-full flex-wrap items-center gap-2 text-xs text-red-400"
      />
    </>
  );
}

/**
 * A lead's Activate on one proposed revision — its own lock, so activating
 * one revision never leaves another row looking idle mid-write.
 */
function ActivateRevision({
  slug,
  rev,
  label,
  onActivated,
}: {
  slug: string;
  rev: number;
  label: string;
  onActivated: (rev: number) => void;
}) {
  const action = useProjectAction();
  return (
    <>
      <ActionButton
        data-action="activate-revision"
        busy={action.busy}
        pendingLabel="Activating…"
        onClick={() =>
          void action.run(
            `/api/projects/${encodeURIComponent(slug)}/playbook/${rev}/activate`,
            { body: {}, onSuccess: () => onActivated(rev) },
          )
        }
        className="rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
      >
        {label}
      </ActionButton>
      <ActionError
        action={action}
        className="flex w-full flex-wrap items-center gap-2 text-xs text-red-400"
      />
    </>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { CHANGE_KINDS } from "@/components/projects/changes/kinds";
import { PlanDiffView } from "@/components/projects/changes/PlanDiffView";
import { planDiff } from "@/components/projects/changes/planDiff";
import { groupIterations } from "@/components/projects/iterations/groupIterations";
import { type ProjectAction, useProjectAction } from "@/components/projects/useProjectAction";
import type {
  PlaybookStep,
  ProjectChangeApply,
  ProjectChangeApproveResult,
  ProjectChangeDraftState,
  ProjectChangeKind,
  ProjectChangeReading,
  ProjectChangeResult,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectPlaybookResponse,
} from "@/types";

type DraftView =
  | { status: "idle" }
  | { status: "drafting" }
  | { status: "failed"; detail: string }
  | { status: "ready"; rev: number; steps: PlaybookStep[]; reading: ProjectChangeReading | null };

const STEPS = ["Describe", "When", "Review plan"] as const;

const PRIMARY =
  "rounded-xl bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50";
const SECONDARY =
  "rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "2 requirement changes (a; b) · affects output "X" · supersedes "Y"". */
export function readingLine(reading: ProjectChangeReading): string {
  const parts = [
    `${plural(reading.changes.length, "requirement change")}${
      reading.changes.length ? ` (${reading.changes.join("; ")})` : ""
    }`,
  ];
  if (reading.affected_outputs.length) {
    parts.push(
      `affects ${reading.affected_outputs.length === 1 ? "output" : "outputs"} ${reading.affected_outputs
        .map((o) => `“${o.title}”`)
        .join(", ")}`,
    );
  }
  if (reading.supersedes.length) {
    parts.push(
      `supersedes ${reading.supersedes
        .map((s) => `“${s.body.length > 60 ? `${s.body.slice(0, 57)}…` : s.body}”`)
        .join(", ")}`,
    );
  }
  return parts.join(" · ");
}

function ActionError<T>({ action, label }: { action: ProjectAction<T>; label: string }) {
  if (!action.error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-danger)]">
      <span className="min-w-0 flex-1">{action.error}</span>
      <ActionButton
        busy={action.busy}
        pendingLabel="Retrying…"
        onClick={() => void action.retry()}
        aria-label={`Retry ${label}`}
      >
        Retry
      </ActionButton>
    </div>
  );
}

/**
 * "What's changed?": describe → when should it apply → review the agent's
 * updated plan → approve. One `POST /changes` records the requirement (and,
 * for "apply now", stops the open run keeping its finished work); the agent
 * drafts the revised plan server-side and the sheet polls for it. Changes
 * reach the next run only — never a conversation already in flight.
 */
export function ChangeRequestSheet({
  project,
  playbook,
  directives,
  initialText,
  onClose,
  onEditPlan,
  pollMs = 1500,
}: {
  project: ProjectDetail;
  playbook: ProjectPlaybookResponse | null;
  directives: ProjectDirectivesResponse | null;
  initialText?: string;
  onClose: () => void;
  /** Open the Plan tab; defaults to navigating to `?tab=plan`. */
  onEditPlan?: () => void;
  /** Draft poll interval (tests shorten it). */
  pollMs?: number;
}) {
  const router = useRouter();
  const base = `/api/projects/${encodeURIComponent(project.slug)}`;
  const history = useMemo(
    () => groupIterations(project, directives, playbook),
    [project, directives, playbook],
  );
  const [text, setText] = useState(initialText ?? "");
  const [kinds, setKinds] = useState<ProjectChangeKind[]>([]);
  const [apply, setApply] = useState<ProjectChangeApply>("now");
  const [result, setResult] = useState<ProjectChangeResult | null>(null);
  // Frozen at submit: the refresh after a write moves the live numbers on.
  const [frozen, setFrozen] = useState<{ openRun: number | null; nextNo: number } | null>(null);
  const [draft, setDraft] = useState<DraftView>({ status: "idle" });
  const [approved, setApproved] = useState<ProjectChangeApproveResult | null>(null);

  const create = useProjectAction<ProjectChangeResult>();
  const approve = useProjectAction<ProjectChangeApproveResult>();
  const save = useProjectAction<ProjectChangeApproveResult>();
  const redraft = useProjectAction<{ draft: ProjectChangeDraftState }>();
  const busy = create.busy || approve.busy || save.busy || redraft.busy;

  const openRun = frozen ? frozen.openRun : (history.openRun?.run_no ?? null);
  const nextNo = frozen ? frozen.nextNo : history.nextIterationNo;
  const submitted = result !== null;
  const step = submitted ? 3 : text.trim() ? 2 : 1;
  const changeId = result?.change.id ?? null;
  const fallbackReading = result?.change.reading ?? null;

  useEffect(() => {
    if (draft.status !== "drafting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`${base}/playbook/draft`, { cache: "no-store" });
        const state = (await res.json()) as ProjectChangeDraftState;
        if (cancelled) return;
        if (state.status === "done" && typeof state.rev === "number") {
          const pres = await fetch(`${base}/playbook`, { cache: "no-store" });
          const book = (await pres.json()) as ProjectPlaybookResponse;
          if (cancelled) return;
          const rev = book.revisions?.find((r) => r.rev === state.rev);
          if (!pres.ok || !rev) {
            setDraft({ status: "failed", detail: "Could not load the drafted plan." });
            return;
          }
          setDraft({
            status: "ready",
            rev: rev.rev,
            steps: rev.steps ?? [],
            reading: state.reading ?? fallbackReading,
          });
          return;
        }
        if (state.status === "failed" || state.status === "idle") {
          setDraft({
            status: "failed",
            detail: state.detail ?? "The agent could not draft a plan.",
          });
          return;
        }
      } catch {
        // A dropped poll is retried on the next tick.
      }
      if (!cancelled) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [draft.status, base, pollMs, fallbackReading]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const close = () => {
    if (!busy) onClose();
  };

  const submit = () =>
    void create.run(`${base}/changes`, {
      body: { text: text.trim(), kinds, apply },
      onSuccess: (data) => {
        setFrozen({ openRun, nextNo });
        setResult(data);
        if (apply !== "record") setDraft({ status: "drafting" });
      },
    });

  const ready = draft.status === "ready" ? draft : null;
  const supersedes = ready?.reading?.supersedes.map((s) => s.id) ?? [];
  const approvePath = changeId ? `${base}/changes/${encodeURIComponent(changeId)}/approve` : "";
  const doApprove = () =>
    ready &&
    void approve.run(approvePath, {
      body: { rev: ready.rev, supersedes },
      onSuccess: setApproved,
    });
  const doSave = () =>
    ready &&
    void save.run(approvePath, {
      body: { rev: ready.rev, start: false, supersedes },
      onSuccess: setApproved,
    });
  const doRedraft = () =>
    changeId &&
    void redraft.run(`${base}/changes/${encodeURIComponent(changeId)}/draft`, {
      skipRefresh: true,
      onSuccess: () => setDraft({ status: "drafting" }),
    });
  const editPlan = () => {
    if (busy) return;
    if (onEditPlan) onEditPlan();
    else router.push(`/projects/${encodeURIComponent(project.slug)}?tab=plan`);
    onClose();
  };

  const toggleKind = (kind: ProjectChangeKind) =>
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));

  const options: { value: ProjectChangeApply; title: string; body: string; badge?: string }[] = [
    openRun !== null
      ? {
          value: "now",
          title: `Pause run ${openRun} and apply now`,
          badge: "recommended",
          body: `Run ${openRun} stops now and its finished work is kept, then iteration ${nextNo} starts with the change once you approve the plan below.`,
        }
      : {
          value: "now",
          title: `Apply now and start iteration ${nextNo}`,
          body: "The agent redrafts the plan; approve it below to start.",
        },
    {
      value: "next",
      title: "Queue for the next iteration",
      body:
        openRun !== null
          ? `Run ${openRun} finishes as-is. The dashboard shows “Ready to start iteration ${nextNo}”.`
          : `Nothing starts now. The dashboard shows “Ready to start iteration ${nextNo}”.`,
    },
    {
      value: "record",
      title: "Just record it",
      body: "Save as a requirement and start nothing. You can start later from the dashboard.",
    },
  ];

  const submitLabel =
    apply === "record"
      ? "Save requirement"
      : apply === "now" && openRun !== null
        ? `Pause run ${openRun} and redraft the plan`
        : "Redraft the plan";

  const diff = ready ? planDiff(playbook?.active?.steps ?? [], ready.steps) : null;

  return (
    <div
      data-component="ChangeRequestSheet"
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change requirements"
        aria-busy={busy || undefined}
        onClick={(e) => e.stopPropagation()}
        className="mx-auto flex max-h-[92vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl border-x border-t border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <header className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Change requirements</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-sm text-[var(--color-muted)] disabled:opacity-40"
          >
            ✕
          </button>
        </header>

        <div>
          <div className="flex gap-1" aria-hidden>
            {STEPS.map((label, i) => (
              <span
                key={label}
                data-step-done={i < step ? "true" : undefined}
                className={`h-1.5 flex-1 rounded-full ${
                  i < step ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)]"
                }`}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]" aria-live="polite">
            {STEPS.map((label, i) => `${i + 1} ${label}`).join(" · ")} — step {step} of 3
          </p>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">1 · What’s changing</h3>
          <textarea
            aria-label="What’s changing"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={submitted || busy}
            rows={4}
            placeholder="e.g. Add a Chinese edition of every issue."
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm"
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind of change">
            {CHANGE_KINDS.map(({ kind, label, icon }) => {
              const on = kinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  disabled={submitted || busy}
                  onClick={() => toggleKind(kind)}
                  className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-60 ${
                    on
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  <span aria-hidden>{icon} </span>
                  {label}
                </button>
              );
            })}
          </div>
          {ready?.reading ? (
            <p data-testid="agent-reading" className="text-sm">
              <span className="font-medium">Agent’s reading: </span>
              {readingLine(ready.reading)}
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">2 · When should this apply?</h3>
          <div role="radiogroup" aria-label="When should this apply?" className="flex flex-col gap-2">
            {options.map((opt) => (
              <label
                key={opt.value}
                className={`flex cursor-pointer gap-2 rounded-xl border p-3 text-sm ${
                  apply === opt.value
                    ? "border-[var(--color-accent)]"
                    : "border-[var(--color-border)]"
                }`}
              >
                <input
                  type="radio"
                  name="change-apply"
                  value={opt.value}
                  checked={apply === opt.value}
                  disabled={submitted || busy}
                  onChange={() => setApply(opt.value)}
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">
                    {opt.title}
                    {opt.badge ? (
                      <span className="ml-2 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs font-normal">
                        {opt.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">{opt.body}</span>
                </span>
              </label>
            ))}
          </div>
          {!submitted ? (
            <>
              {project.archived ? (
                <p className="text-xs text-[var(--color-muted)]">
                  This project is archived — restore it to change its requirements.
                </p>
              ) : null}
              <ActionButton
                busy={create.busy}
                pendingLabel={apply === "record" ? "Saving…" : "Sending…"}
                disabled={!text.trim() || project.archived || busy}
                onClick={submit}
                className={PRIMARY}
              >
                {submitLabel}
              </ActionButton>
              <ActionError action={create} label="sending the change" />
            </>
          ) : null}
        </section>

        {result && result.stopped_run ? (
          <p role="status" className="text-sm">
            Run {result.stopped_run} was stopped. Its finished work is kept.
          </p>
        ) : null}

        {result && apply === "record" ? (
          <section role="status" className="flex flex-col gap-2">
            <p className="text-sm">
              Saved as a requirement. It applies from the next run; nothing was started.
            </p>
            <button type="button" onClick={close} disabled={busy} className={SECONDARY}>
              Done
            </button>
          </section>
        ) : null}

        {result && apply !== "record" ? (
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center justify-between text-sm font-medium">
              <span>3 · Agent’s updated plan</span>
              {ready ? (
                <span className="text-xs font-normal text-[var(--color-muted)]">rev {ready.rev} ready</span>
              ) : null}
            </h3>
            {draft.status === "drafting" ? (
              <p role="status" className="text-sm text-[var(--color-muted)]">
                <span
                  aria-hidden
                  className="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]"
                />
                The agent is drafting the updated plan…
              </p>
            ) : null}
            {draft.status === "failed" ? (
              <div role="alert" className="flex flex-col gap-2 text-sm">
                <p className="text-[var(--color-danger)]">{draft.detail}</p>
                <ActionButton busy={redraft.busy} pendingLabel="Asking…" onClick={doRedraft}>
                  Try again
                </ActionButton>
                <ActionError action={redraft} label="drafting again" />
              </div>
            ) : null}
            {diff ? <PlanDiffView diff={diff} /> : null}

            {ready && !approved ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={editPlan} disabled={busy} className={SECONDARY}>
                    Edit plan
                  </button>
                  <ActionButton
                    busy={save.busy}
                    pendingLabel="Saving…"
                    disabled={busy}
                    onClick={doSave}
                    className={SECONDARY}
                  >
                    Save without running
                  </ActionButton>
                </div>
                <ActionButton
                  busy={approve.busy}
                  pendingLabel="Starting…"
                  disabled={busy}
                  onClick={doApprove}
                  className={PRIMARY}
                >
                  Approve &amp; start iteration {nextNo}
                </ActionButton>
                <ActionError action={approve} label="approving" />
                <ActionError action={save} label="saving the plan" />
              </div>
            ) : null}

            {approved ? (
              <div role="status" className="flex flex-col gap-2 text-sm">
                <p>
                  Plan rev {approved.rev} is active.{" "}
                  {approved.run ? (
                    <>
                      Iteration {nextNo} started —{" "}
                      <Link
                        className="underline"
                        href={`/projects/${encodeURIComponent(project.slug)}/runs/${approved.run.run_no}`}
                      >
                        open run {approved.run.run_no}
                      </Link>
                      .
                    </>
                  ) : (
                    `Saved without running — start iteration ${nextNo} from the dashboard when you’re ready.`
                  )}
                </p>
                <button type="button" onClick={close} disabled={busy} className={SECONDARY}>
                  Done
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

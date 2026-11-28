"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ActionError } from "@/components/projects/ActionError";
import { readRunHistory } from "@/components/projects/execution/runData";
import { durationLabel } from "@/components/projects/format";
import {
  groupInputLinks,
  inputCount,
} from "@/components/projects/inputs/inputKinds";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useT } from "@/i18n";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Pill } from "@/components/ui/Pill";
import type {
  PlaybookRev,
  ProjectIterationBatch,
  ProjectDetail,
  ProjectLink,
  ProjectPlaybookResponse,
  ProjectRunBrief,
} from "@/types";

/**
 * Start-run dialog (projects-detail-redesign, frame "Start run dialog"):
 * pick the plan version, see the iteration batch (inputs) it will run, an
 * honest estimate from prior runs, then POST /runs with `playbook_rev`
 * and the chosen `batch_id` (or a just-created batch, or none).
 */
export function StartRunSheet({
  project,
  playbook,
  onClose,
  onStarted,
}: {
  project: ProjectDetail;
  playbook: ProjectPlaybookResponse | null;
  onClose(): void;
  onStarted?: () => void;
}) {
  const t = useT("projects");
  const action = useProjectAction();
  const revisions = useMemo(
    () =>
      [...(playbook?.revisions ?? [])].sort(
        (a, b) => b.rev - a.rev || (b.activated_at ?? 0) - (a.activated_at ?? 0),
      ),
    [playbook],
  );
  const [revNo, setRevNo] = useState<number | null>(
    playbook?.active?.rev ?? revisions[0]?.rev ?? null,
  );
  const chosen: PlaybookRev | null =
    revisions.find((r) => r.rev === revNo) ?? playbook?.active ?? null;
  const steps = chosen?.steps?.length ?? 0;

  const groups = useMemo(() => groupInputLinks(project.links), [project.links]);
  const allInputs = useMemo(
    () => [...groups.files, ...groups.links, ...groups.memories],
    [groups],
  );
  const lastRun = useMemo<ProjectRunBrief | null>(
    () =>
      [...project.runs]
        .filter((r) => r.started_at != null)
        .sort((a, b) => b.started_at - a.started_at)[0] ?? null,
    [project.runs],
  );
  const newSince = useMemo(() => {
    if (!lastRun) return 0;
    return allInputs.filter((l) => l.added_at > lastRun.started_at).length;
  }, [allInputs, lastRun]);

  // Briefs don't carry cost; the record endpoint does on some servers —
  // read it defensively so the estimate shows cost when it can.
  const [history, setHistory] = useState<ProjectRunBrief[] | null>(null);
  useEffect(() => {
    let alive = true;
    void readRunHistory(project.slug)
      .then((runs) => {
        if (alive) setHistory(runs);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project.slug]);

  // Estimate from prior runs' durations and costs; approvals from steps the
  // playbook marks `checkpoint` (they pause for a human).
  const estimate = useMemo(() => {
    const runs = history?.length ? history : project.runs;
    const durs = runs
      .map((r) =>
        r.duration_seconds ??
        (r.ended_at ? r.ended_at - r.started_at : null),
      )
      .filter((d): d is number => typeof d === "number" && d > 0);
    const costs = runs
      .map((r) => (r as ProjectRunBrief & { cost?: number | null }).cost)
      .filter((c): c is number => typeof c === "number" && c > 0);
    const avg = (xs: number[]) =>
      xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
    return {
      minSecs: durs.length ? Math.max(30, Math.round(avg(durs) * 0.8)) : 0,
      maxSecs: durs.length ? Math.max(60, Math.round(avg(durs) * 1.2)) : 0,
      cost: costs.length ? avg(costs) : null,
      checkpoint: (chosen?.steps ?? []).filter((s) => s.checkpoint).length,
      hasHistory: durs.length > 0,
    };
  }, [history, project.runs, chosen]);

  const [batches, setBatches] = useState<ProjectIterationBatch[] | null>(null);
  const [batchId, setBatchId] = useState<string>("");
  const [note, setNote] = useState("");
  const [newBatch, setNewBatch] = useState({ title: "", description: "" });
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${encodeURIComponent(project.slug)}/batches`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setBatches(d.batches ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project.slug]);

  async function start() {
    let chosen = batchId || undefined;
    if (batchId === "__new__") {
      const created = await action.run(
        `/api/projects/${encodeURIComponent(project.slug)}/batches`,
        {
          method: "POST",
          body: {
            title: newBatch.title.trim(),
            description: newBatch.description.trim() || undefined,
          },
        },
      );
      const id = created?.ok ? created.data?.id : undefined;
      if (typeof id !== "string") return;
      chosen = id;
    }
    const result = await action.run(
      `/api/projects/${encodeURIComponent(project.slug)}/runs`,
      {
        method: "POST",
        body: {
          ...(revNo != null ? { playbook_rev: revNo } : {}),
          ...(chosen ? { batch_id: chosen } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      },
    );
    if (result?.ok) {
      onStarted?.();
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/50 sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t("startRun.title")}
        data-component="StartRunSheet"
        className="mx-auto flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-hidden rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-base font-semibold">{t("startRun.title")}</h2>
          <p className="text-xs text-[var(--color-muted)]">
            {t("startRun.subtitle")}
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">

        <Field label={t("startRun.planVersion")}>
          <SelectBox
            ariaLabel={t("startRun.planVersion")}
            data-appmcp-hint="Choose which saved plan version to run"
          >
            <select
              aria-label={t("startRun.planVersion")}
              value={revNo ?? ""}
              onChange={(e) => setRevNo(Number(e.target.value))}
              className="w-full appearance-none bg-transparent px-3 py-2 text-sm font-semibold outline-none"
              data-testid="start-run-rev"
            >
              {revisions.map((r) => (
                <option key={r.rev} value={r.rev}>
                  v{r.rev}
                  {playbook?.active?.rev === r.rev ? " · latest" : ""}
                </option>
              ))}
              {revisions.length === 0 ? (
                <option value="">{t("startRun.noPlan")}</option>
              ) : null}
            </select>
            <Chevron />
          </SelectBox>
          {chosen ? (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {steps > 0
                ? t("startRun.stepsFrom", { steps })
                : t("startRun.noSteps")}
            </p>
          ) : null}
        </Field>

        <Field label={t("startRun.batch")}>
          <SelectBox
            ariaLabel={t("startRun.batch")}
            data-appmcp-hint="Choose which named batch this run is filed under"
          >
            <select
              aria-label={t("startRun.batch")}
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
              className="w-full appearance-none bg-transparent px-3 py-2 text-sm font-semibold outline-none"
              data-testid="start-run-batch"
            >
              <option value="">{t("startRun.noBatch")}</option>
              {(batches ?? [])
                .filter((b) => !b.archived_at)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                    {b.run_count ? ` · ${b.run_count}` : ""}
                  </option>
                ))}
              <option value="__new__">{t("startRun.newBatch")}</option>
            </select>
            <Chevron />
          </SelectBox>
          {batchId === "__new__" ? (
            <div className="mt-2 flex flex-col gap-2">
              <input
                value={newBatch.title}
                onChange={(e) =>
                  setNewBatch((n) => ({ ...n, title: e.target.value }))
                }
                placeholder={t("startRun.newBatchTitle")}
                data-appmcp-hint="Title for the new batch"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <input
                value={newBatch.description}
                onChange={(e) =>
                  setNewBatch((n) => ({ ...n, description: e.target.value }))
                }
                placeholder={t("startRun.newBatchDesc")}
                data-appmcp-hint="Optional description for the new batch"
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          ) : null}
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {inputCount(groups)} {t("startRun.inputs")}
            {newSince > 0 && lastRun
              ? ` · ${newSince} ${t("startRun.newSince", { run: lastRun.run_no })}`
              : ""}
          </p>
        </Field>

        <Field label={t("startRun.note")}>
          <textarea
            aria-label={t("startRun.note")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("startRun.notePlaceholder")}
            rows={2}
            data-appmcp-hint="One-off instruction for this run only — it never becomes a standing rule"
            data-testid="start-run-note"
            className="block w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </Field>

        {allInputs.length ? (
          <Field label={t("startRun.uses")}>
            <div
              className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto"
              data-testid="start-run-inputs"
            >
              {allInputs.map((l) => (
                <span key={`${l.kind}:${l.ref}`} title={l.label ?? l.ref}>
                  <Pill tone="muted">{chipLabel(l)}</Pill>
                </span>
              ))}
            </div>
          </Field>
        ) : null}

        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-muted)]">
          {estimate.hasHistory ? (
            <>
              {t("startRun.about")} {durationLabel(estimate.minSecs)}–
              {durationLabel(estimate.maxSecs)}
              {estimate.cost != null
                ? ` · ${t("startRun.aboutCost", { cost: `$${estimate.cost.toFixed(2)}` })}`
                : ""}
              {estimate.checkpoint > 0
                ? ` · ${estimate.checkpoint} ${t("startRun.willApprove")}`
                : ""}
            </>
          ) : (
            t("startRun.noEstimate")
          )}
        </div>

        <ActionError
          action={action}
          className="text-xs text-[var(--color-danger)]"
        />
        </div>

        <div
          className="flex items-center justify-end gap-2"
          style={{ paddingBottom: "var(--safe-bottom)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={action.busy}
            data-appmcp-hint="Close without starting a run"
            className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {t("cancel")}
          </button>
          <BusyRegion busy={action.busy} label={t("startRun.starting")}>
            <button
              type="button"
              onClick={() => void start()}
              disabled={action.busy}
              data-action="confirm-start-run"
              data-appmcp-hint="Start the run with the chosen plan version"
              className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {t("startRun.start")}
            </button>
          </BusyRegion>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-[var(--color-muted)]">
        {label}
      </p>
      {children}
    </div>
  );
}

function SelectBox({
  ariaLabel,
  disabled,
  children,
  ...rest
}: {
  ariaLabel: string;
  disabled?: boolean;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      {...rest}
      className={`flex items-center rounded-[var(--radius-md)] border border-[var(--color-border)] ${
        disabled ? "opacity-80" : ""
      }`}
    >
      {children}
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 8 4" className="mr-3 h-1 w-2 shrink-0" aria-hidden>
      <path
        d="M1 0l3 3 3-3"
        fill="none"
        stroke="var(--color-muted)"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function chipLabel(l: ProjectLink): string {
  if (l.label) return l.label;
  const tail = l.ref.split("/").filter(Boolean).pop() ?? l.ref;
  return tail.length > 30 ? `${tail.slice(0, 28)}…` : tail;
}

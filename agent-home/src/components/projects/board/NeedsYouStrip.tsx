"use client";

import { useEffect, useRef, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { NeedsYouCard, type BoardUpdate } from "@/components/projects/board/NeedsYouCard";
import {
  cardRunNo,
  reconcileTask,
  withStatus,
  type NeedsYouItem,
} from "@/components/projects/board/model";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type { ProjectBoardTask, ProjectCardsApproveResponse } from "@/types";

export interface StripItem extends NeedsYouItem {
  /** The live row, `null` once an optimistic archive took it off. */
  live: ProjectBoardTask | null;
}

/**
 * "Needs you": every card the agent can't move past without a person, on
 * top of the board, each with one-tap verbs — plus Approve all N, one
 * request carrying each triage card once.
 */
export function NeedsYouStrip({
  slug,
  items,
  canAct,
  profiles,
  memberIds,
  cardRuns,
  now,
  update,
  onHold,
  onRelease,
}: {
  slug: string;
  items: StripItem[];
  canAct: boolean;
  profiles: string[];
  memberIds: ReadonlySet<string>;
  cardRuns: Record<string, number>;
  now: number;
  update: BoardUpdate;
  onHold: (task: ProjectBoardTask) => void;
  onRelease: (taskId: string) => void;
}) {
  const bulk = useProjectAction<ProjectCardsApproveResponse>();
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const [bulkErrors, setBulkErrors] = useState<Record<string, string>>({});
  const snapshots = useRef<ProjectBoardTask[]>([]);

  // The approved cards leave the strip once the server confirmed and the
  // refresh landed; on a refusal they stay, rolled back, with the reason.
  useEffect(() => {
    if (!bulk.busy && !bulk.error) {
      for (const id of bulkIds) onRelease(id);
    }
  }, [bulk.busy, bulk.error, bulkIds, onRelease]);

  const approvable = items
    .filter((i) => i.kind === "approve" && i.live?.status === "triage")
    .map((i) => i.live as ProjectBoardTask);

  const applyAll = (tasks: ProjectBoardTask[]) =>
    update((b) => tasks.reduce((acc, t) => withStatus(acc, t.id, "ready"), b));
  const rollbackAll = (tasks: ProjectBoardTask[]) =>
    update((b) => tasks.reduce((acc, t) => reconcileTask(acc, t), b));

  const settle = (data: ProjectCardsApproveResponse) => {
    const byId = new Map(snapshots.current.map((t) => [t.id, t]));
    const errors: Record<string, string> = {};
    update((b) => {
      let next = b;
      for (const r of data.results ?? []) {
        if (r.ok && r.card) next = reconcileTask(next, r.card);
        else if (!r.ok) {
          const snap = byId.get(r.task_id);
          if (snap) next = reconcileTask(next, snap);
        }
      }
      return next;
    });
    for (const r of data.results ?? []) {
      if (!r.ok) errors[r.task_id] = r.error || "That did not go through.";
    }
    setBulkErrors(errors);
  };

  const approveAll = async () => {
    if (bulk.busy || approvable.length === 0) return;
    const tasks = approvable;
    snapshots.current = tasks;
    setBulkErrors({});
    setBulkIds(tasks.map((t) => t.id));
    for (const t of tasks) onHold(t);
    applyAll(tasks);
    const result = await bulk.run(`/api/projects/${encodeURIComponent(slug)}/cards/approve`, {
      method: "POST",
      body: { task_ids: tasks.map((t) => t.id) },
      onSuccess: settle,
    });
    if (result && !result.ok) rollbackAll(tasks);
  };

  const retryAll = async () => {
    if (bulk.busy) return;
    const tasks = snapshots.current;
    setBulkIds(tasks.map((t) => t.id));
    for (const t of tasks) onHold(t);
    applyAll(tasks);
    const result = await bulk.retry();
    if (result && !result.ok) rollbackAll(tasks);
  };

  const inBulk = new Set(bulkIds);
  const bulkCount = bulk.busy ? bulkIds.length : approvable.length;

  return (
    <section
      data-component="NeedsYouStrip"
      aria-label="Needs you"
      className="rounded-2xl border-2 border-amber-500/50 bg-amber-500/5 p-3"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">
          Needs you{items.length > 0 ? ` · ${items.length}` : ""}
        </h3>
        <p className="flex-1 text-xs text-[var(--color-muted)]">
          The agent can&rsquo;t continue until a person acts
        </p>
        {canAct && (bulkCount >= 2 || (bulk.busy && bulkCount > 0)) ? (
          <ActionButton
            busy={bulk.busy}
            pendingLabel={`Approving ${bulkCount}…`}
            onClick={() => void approveAll()}
            className="rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Approve all {bulkCount}
          </ActionButton>
        ) : null}
      </div>
      {bulk.error ? (
        <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-[var(--color-danger)]">
          <span>Couldn&rsquo;t approve them: {bulk.error}</span>
          <ActionButton
            busy={bulk.busy}
            pendingLabel="Retrying…"
            onClick={() => void retryAll()}
            className="rounded-md border border-red-400/50 px-2 py-0.5 text-xs"
          >
            Retry
          </ActionButton>
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">Nothing needs a person right now.</p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-3">
          {items.map((item) => (
            <NeedsYouCard
              key={item.task.id}
              slug={slug}
              task={item.live}
              snapshot={item.task}
              kind={item.kind}
              canAct={canAct}
              profiles={profiles}
              memberIds={memberIds}
              runNo={cardRunNo(item.task, cardRuns)}
              now={now}
              update={update}
              onHold={onHold}
              onRelease={onRelease}
              bulkBusy={bulk.busy && inBulk.has(item.task.id)}
              bulkError={bulkErrors[item.task.id] ?? null}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

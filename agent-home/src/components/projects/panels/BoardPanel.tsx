"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { isTaskRow, reconcileTask } from "@/components/projects/board/model";
import {
  addTaskToBoard,
  cardMoves,
  moveTaskInBoard,
  newBoardCard,
} from "@/components/projects/cardMoves";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { useServerState } from "@/components/ui/useRefresh";
import type { ProjectBoardTask, ProjectBoardView } from "@/types";

/**
 * Columns a human may start a card in. Every card is born in `triage`
 * (§10: a project asking for work is not a human approving it); "New card"
 * in `ready` creates it and approves it in one gesture.
 */
export const NEW_CARD_COLUMNS = ["triage", "ready"] as const;

type BoardUpdate = (fn: (board: ProjectBoardView) => ProjectBoardView) => void;

/**
 * The project's cards, one column per stage — the board's full view
 * ("Show all 8 stages"). On a phone each column snaps to the screen; from
 * `md:` up the columns flow side by side. Each card moves from its own row
 * ("Move to…") with its own action lock; each startable column offers "New
 * card". The board read is fan-out safe: when it is unavailable the rest of
 * the page still renders.
 */
export function BoardPanel({
  slug,
  board,
  archived = false,
}: {
  slug: string;
  board: ProjectBoardView | null;
  archived?: boolean;
}) {
  // Optimistic copy of the server-rendered board: moves and new cards apply
  // here the moment they're requested, and the refresh that follows swaps in
  // the server's authoritative board (see `useServerState`).
  const [liveBoard, setLiveBoard] = useServerState(board);
  const [newIn, setNewIn] = useState<string | null>(null);
  const update: BoardUpdate = (fn) => setLiveBoard((prev) => (prev ? fn(prev) : prev));

  const canStartIn = (column: string) =>
    !archived && (NEW_CARD_COLUMNS as readonly string[]).includes(column);

  return (
    <section
      id="panel-board"
      data-component="BoardPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Board
      </h2>

      {liveBoard == null ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The board is unavailable right now — the profile it lives on could
          not be reached.
        </p>
      ) : (
        <>
          {liveBoard.columns.every((column) => column.tasks.length === 0) ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              No cards yet. The first run creates one card per plan step;
              you can also start one with <strong>+ New card</strong> in a
              column below or add work from the header&rsquo;s Add sheet.
            </p>
          ) : null}
          <div className="mt-2 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 md:grid md:grid-cols-3 md:overflow-visible">
            {liveBoard.columns.map((column) => (
              <div
                key={column.name}
                data-component="BoardColumn"
                className="min-w-[85%] snap-center rounded-xl bg-[var(--color-surface-2)] p-2 md:min-w-0"
              >
                <div className="flex items-center px-1 py-1">
                  <p className="flex-1 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    {column.name}
                    {column.tasks.length > 0 ? ` · ${column.tasks.length}` : ""}
                  </p>
                  {canStartIn(column.name) ? (
                    <button
                      type="button"
                      onClick={() => setNewIn(newIn === column.name ? null : column.name)}
                      className="rounded-md px-1.5 py-0.5 text-xs text-[var(--color-accent)] disabled:opacity-40"
                    >
                      + New card
                    </button>
                  ) : null}
                </div>
                {newIn === column.name ? (
                  <ColumnNewCard
                    slug={slug}
                    column={column.name}
                    update={update}
                    onDone={() => setNewIn(null)}
                  />
                ) : null}
                <ul className="flex flex-col gap-1.5">
                  {column.tasks.map((task) => (
                    <StageCard
                      key={task.id}
                      slug={slug}
                      task={task}
                      archived={archived}
                      update={update}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** One card in the full stage view, with its own lock for "Move to…". */
function StageCard({
  slug,
  task,
  archived,
  update,
}: {
  slug: string;
  task: ProjectBoardTask;
  archived: boolean;
  update: BoardUpdate;
}) {
  const action = useProjectAction<ProjectBoardTask>();
  const before = useRef<ProjectBoardTask>(task);
  const target = useRef<string | null>(null);
  const moves = archived ? [] : cardMoves(task.status);
  const path = `/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(task.id)}`;

  const send = async (to: string, again: boolean) => {
    // Apply the column move immediately; a refusal restores the card.
    update((b) =>
      to === "archived"
        ? reconcileTask(b, { ...task, status: "archived" })
        : moveTaskInBoard(b, task.id, to),
    );
    const request = {
      method: "PATCH" as const,
      body: { status: to },
      onSuccess: (data: ProjectBoardTask) => {
        if (isTaskRow(data)) update((b) => reconcileTask(b, data));
      },
    };
    const result = again ? await action.retry() : await action.run(path, request);
    if (result && !result.ok) update((b) => reconcileTask(b, before.current));
  };

  const move = (to: string) => {
    if (action.busy) return;
    before.current = task;
    target.current = to;
    void send(to, false);
  };

  return (
    <li
      data-component="BoardCard"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <Link
        href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(task.id)}`}
        className="block px-2.5 py-2 text-sm active:opacity-70"
      >
        <span className="line-clamp-2 block">{task.title}</span>
        <span className="block truncate text-xs text-[var(--color-muted)]">
          {task.assignee ?? "unassigned"}
          {task.current_step_key ? ` · ${task.current_step_key}` : ""}
        </span>
      </Link>
      {moves.length > 0 ? (
        <div className="flex items-center gap-1 px-2.5 pb-1.5">
          <select
            aria-label={`Move ${task.title}`}
            value=""
            disabled={action.busy}
            aria-busy={action.busy || undefined}
            onChange={(e) => {
              if (e.target.value) move(e.target.value);
            }}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-1 text-xs disabled:opacity-40"
          >
            <option value="">{action.busy ? "Moving…" : "Move to…"}</option>
            {moves.map((m) => (
              <option key={m.to} value={m.to}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {action.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1.5 text-xs text-[var(--color-danger)]">
          <span>{action.error}</span>
          <ActionButton
            busy={action.busy}
            pendingLabel="Retrying…"
            onClick={() => {
              if (target.current) void send(target.current, true);
            }}
            className="rounded-md border border-red-400/50 px-2 py-0.5 text-xs"
          >
            Retry
          </ActionButton>
        </div>
      ) : null}
    </li>
  );
}

/**
 * "New card" in a column: create (lands in triage), then — for a column
 * past triage — move it there. Each step is its own locked action.
 */
function ColumnNewCard({
  slug,
  column,
  update,
  onDone,
}: {
  slug: string;
  column: string;
  update: BoardUpdate;
  onDone: () => void;
}) {
  const create = useProjectAction<{ task_id?: string }>();
  const moveTo = useProjectAction<ProjectBoardTask>();
  const [title, setTitle] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const busy = create.busy || moveTo.busy;
  const base = `/api/projects/${encodeURIComponent(slug)}/cards`;

  const submit = async () => {
    const t = title.trim();
    if (!t) {
      setNote("A card needs a title.");
      return;
    }
    if (busy) return;
    setNote(null);
    const made = await create.run(base, {
      method: "POST",
      body: { title: t },
      skipRefresh: column !== "triage",
    });
    if (!made?.ok) return;
    const taskId = typeof made.data?.task_id === "string" ? made.data.task_id : null;
    let finalColumn = column;
    if (column !== "triage" && taskId) {
      const moved = await moveTo.run(`${base}/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: { status: column },
      });
      if (!moved?.ok) {
        finalColumn = "triage";
        setNote("The card was created in triage.");
      }
    }
    // The POST only answers with the id — show a minimal card right away
    // rather than waiting for the refresh to paint it.
    if (taskId) {
      update((b) => addTaskToBoard(b, finalColumn, newBoardCard(taskId, t, finalColumn)));
    }
    setTitle("");
    if (finalColumn === column) onDone();
  };

  const error = create.error ?? moveTo.error;
  return (
    <form
      data-component="NewCardForm"
      className="mb-1.5 flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <BusyRegion busy={busy} label="Creating…">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          aria-label={`New card in ${column}`}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </BusyRegion>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-2 py-1 text-xs text-[var(--color-muted)]"
        >
          Cancel
        </button>
        <span className="flex-1" />
        <ActionButton
          type="submit"
          busy={busy}
          pendingLabel="Creating…"
          className="rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
        >
          Create
        </ActionButton>
      </div>
      {error || note ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {[error, note].filter(Boolean).join(" ")}
        </p>
      ) : null}
    </form>
  );
}

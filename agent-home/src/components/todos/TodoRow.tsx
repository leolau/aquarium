"use client";

import Link from "next/link";

import { ActionButton } from "@/components/ui/ActionButton";

import type { Todo, TodoStage } from "@/types";

/** The stage vocabulary, in the order a to-do moves through it. */
export const STAGE_LABEL: Record<TodoStage, string> = {
  staged: "Staged",
  open: "Open",
  working: "Working",
  done: "Done",
  dismissed: "Dismissed",
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: "#ef4444",
  high: "#f59e0b",
  normal: "var(--color-muted)",
  low: "var(--color-muted)",
};

/** Where a to-do came from, at a glance in a mixed list. */
const SOURCE_GLYPH: Record<string, string> = {
  inbound: "✉️",
  analysis: "🔎",
  user: "🙋",
  agent: "🤖",
  cron: "⏱",
};

export function sourceGlyph(kind: string | null): string {
  return kind ? (SOURCE_GLYPH[kind] ?? "•") : "•";
}

/**
 * "overdue", "today", "in 3d" — a due date is only useful as a distance.
 *
 * The exact timestamp is on the detail page; in a list what the reader is
 * deciding is "does this need me before the others", and a formatted date
 * makes them do that subtraction themselves.
 */
export function dueLabel(iso: string | null): string {
  if (!iso) return "";
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return "";
  const days = Math.floor((due.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days}d`;
  return due.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The one-line excerpt under the title. */
export function excerpt(text: string, max = 140): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * One to-do in the list: what it is, how urgent, when it is due, and where it
 * came from.
 *
 * The staged ones are dimmed rather than hidden or separated. They were
 * captured *without* interrupting the user, so they must not read as demands —
 * but they are also the pool the user promotes from, and a collapsed section
 * nobody expands is the same as not capturing them at all.
 */
export function TodoRow({
  todo,
  onStage,
  busy = false,
}: {
  todo: Todo;
  /** Move the to-do along; the list owns the request and the optimism. */
  onStage?: (todo: Todo, stage: TodoStage) => unknown;
  busy?: boolean;
}) {
  const due = dueLabel(todo.due_at);
  const preview = excerpt(todo.description);
  const staged = todo.stage === "staged";

  return (
    <li data-component="TodoRow">
      <div
        className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition hover:border-[var(--color-accent)] ${
          staged ? "opacity-70" : ""
        }`}
      >
        <Link
          href={`/todos/${encodeURIComponent(todo.id)}`}
          className="flex items-start gap-2"
        >
          <span aria-hidden className="text-base leading-5">
            {sourceGlyph(todo.source_kind)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">{todo.title}</span>
              {due ? (
                <span
                  className="shrink-0 text-[10px]"
                  style={{
                    color:
                      due === "overdue"
                        ? PRIORITY_COLOR.critical
                        : "var(--color-muted)",
                  }}
                >
                  {due}
                </span>
              ) : null}
            </div>
            {preview ? (
              <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                {preview}
              </p>
            ) : null}
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-muted)]">
              <span className="rounded-full border border-[var(--color-border)] px-1.5">
                {STAGE_LABEL[todo.stage]}
              </span>
              {todo.priority !== "normal" ? (
                <span
                  className="rounded-full px-1.5"
                  style={{
                    border: `1px solid ${PRIORITY_COLOR[todo.priority]}`,
                    color: PRIORITY_COLOR[todo.priority],
                  }}
                >
                  {todo.priority}
                </span>
              ) : null}
              {todo.snoozed_until ? <span>snoozed</span> : null}
              {todo.origin === "triage" ? <span>from triage</span> : null}
            </p>
          </div>
        </Link>

        {onStage && todo.stage !== "done" && todo.stage !== "dismissed" ? (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {staged ? (
              <Action
                label="Open it"
                disabled={busy}
                onClick={() => onStage(todo, "open")}
              />
            ) : null}
            {todo.stage === "open" ? (
              <Action
                label="Work on it"
                disabled={busy}
                onClick={() => onStage(todo, "working")}
              />
            ) : null}
            <Action
              label="Done"
              disabled={busy}
              onClick={() => onStage(todo, "done")}
            />
            <Action
              label="Dismiss"
              disabled={busy}
              onClick={() => onStage(todo, "dismissed")}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Action({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => unknown;
  disabled?: boolean;
}) {
  return (
    <ActionButton
      onAction={onClick}
      disabled={disabled}
      busyLabel="Saving…"
      className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
    >
      {label}
    </ActionButton>
  );
}

"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
  STATUS_LABEL,
  assigneeAvatar,
  commentCount,
  shortAge,
  statusTone,
  taskAgeSeconds,
  type StatusTone,
} from "@/components/projects/board/model";
import { RefBadge } from "@/components/refs/RefBadge";
import type { ProjectBoardTask } from "@/types";

const PILL: Record<StatusTone, string> = {
  warn: "bg-amber-500/15 text-[var(--color-warn-text)]",
  accent: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  ok: "bg-emerald-500/15 text-emerald-300",
  muted: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
};

const AVATAR = {
  person: "bg-orange-500",
  agent: "bg-violet-500",
  none: "bg-slate-500",
} as const;

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      data-component="StatusPill"
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${PILL[statusTone(status)]}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function cardHref(slug: string, taskId: string): string {
  return `/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}`;
}

/**
 * One card as a person reads it: the full title (two lines), its stage,
 * who has it (a person's initial or an agent's mark), the run that made it,
 * its age and comments; a running card carries a live dot.
 */
export function CardTile({
  slug,
  task,
  runNo,
  memberIds,
  now,
  highlight = false,
  children,
}: {
  slug: string;
  task: ProjectBoardTask;
  runNo: number | null;
  memberIds: ReadonlySet<string>;
  now: number;
  highlight?: boolean;
  children?: ReactNode;
}) {
  const avatar = assigneeAvatar(task.assignee, memberIds);
  const comments = commentCount(task);
  const waitingForWorker = task.status === "ready" && avatar.kind !== "person";
  return (
    <li
      data-component="BoardTile"
      data-task-id={task.id}
      data-status={task.status}
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 ${
        highlight ? "border-l-4 border-l-amber-400" : ""
      }`}
    >
      <Link
        href={cardHref(slug, task.id)}
        className="line-clamp-2 text-sm font-medium active:opacity-70"
        title={task.title}
      >
        {task.title}
      </Link>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">
        {task.status === "running" ? (
          <span
            data-component="LiveDot"
            aria-label="working now"
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400"
          />
        ) : null}
        <StatusPill status={task.status} />
        <RefBadge value={task.ref} />
        <span
          data-avatar={avatar.kind}
          aria-hidden
          className={`inline-grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold text-white ${AVATAR[avatar.kind]}`}
        >
          {avatar.kind === "agent" ? "A" : avatar.initial}
        </span>
        <span>{avatar.label}</span>
        {waitingForWorker ? <span>· waiting for a worker</span> : null}
        {runNo != null ? <span>· created by run {runNo}</span> : null}
        <span>· {shortAge(taskAgeSeconds(task, now))}</span>
        {comments > 0 ? (
          <span aria-label={`${comments} comments`}>· 💬 {comments}</span>
        ) : null}
      </div>
      {children}
    </li>
  );
}

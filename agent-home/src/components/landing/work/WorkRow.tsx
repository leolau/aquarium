import Link from "next/link";

import { LONG_RUN_MS, fmtElapsed } from "@/components/ui/ActivityStrip";
import type { ActivityItem } from "@/types";

import { IconClock, IconFolder, IconMessage, IconPlay } from "./icons";

export type WorkStatus = "running" | "waiting" | "long";

export const KIND_LABEL: Record<ActivityItem["kind"], string> = {
  chat: "Chat",
  project_run: "Project",
  card: "Card",
  cron: "Scheduled",
};

const KIND_ICON: Record<ActivityItem["kind"], typeof IconFolder> = {
  chat: IconMessage,
  project_run: IconFolder,
  card: IconPlay,
  cron: IconClock,
};

const STATUS: Record<WorkStatus, { label: string; colour: string; dot: string }> = {
  running: {
    label: "Running",
    colour: "text-[var(--color-accent)]",
    dot: "bg-[var(--color-accent)]",
  },
  waiting: {
    label: "Needs you",
    colour: "text-[var(--color-warn)]",
    dot: "bg-[var(--color-warn)]",
  },
  long: {
    label: "Long-running",
    colour: "text-[var(--color-warn-text)]",
    dot: "bg-[var(--color-warn-text)]",
  },
};

export function workStatus(item: ActivityItem, now: number): WorkStatus {
  if (item.status === "waiting") return "waiting";
  if (item.started_at !== null && now - item.started_at * 1000 >= LONG_RUN_MS) return "long";
  return "running";
}

/** Figma `status-pill` (3:39) with the work panel's three tones. */
export function WorkStatusPill({ status }: { status: WorkStatus }) {
  const s = STATUS[status];
  return (
    <span
      data-component="WorkStatusPill"
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-[12px] font-medium leading-[16px] ${s.colour}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/**
 * One background item (Figma `work-row` 3:89): kind icon, name,
 * "kind · profile · elapsed" and a status pill; links to the item.
 */
export function WorkRow({ item, now }: { item: ActivityItem; now: number }) {
  const status = workStatus(item, now);
  const Icon = KIND_ICON[item.kind] ?? IconFolder;
  const elapsed =
    item.started_at !== null ? fmtElapsed(now - item.started_at * 1000) : null;
  const meta = [
    KIND_LABEL[item.kind] ?? item.kind,
    item.profile,
    elapsed ? (status === "waiting" ? `waiting ${elapsed}` : elapsed) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const body = (
    <>
      <Icon size={16} className="shrink-0 text-[var(--color-muted)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium leading-[18px] text-[var(--color-fg)]">
          {item.name}
        </span>
        <span
          data-testid="work-meta"
          className="truncate text-[12px] font-medium leading-[16px] text-[var(--color-muted)]"
        >
          {meta}
        </span>
      </span>
      <WorkStatusPill status={status} />
    </>
  );
  const cls =
    "flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]";

  return (
    <li data-component="WorkRow" data-kind={item.kind} data-status={status}>
      {item.href ? (
        <Link href={item.href} className={`${cls} hover:bg-[var(--color-surface-2)]`}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

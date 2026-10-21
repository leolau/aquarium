"use client";

import { ActionButton } from "@/components/projects/ActionButton";
import { agoLabel } from "@/components/projects/format";
import {
  addedByLabel,
  fileBadge,
  inputRoleLabel,
  isNoteRef,
  noteText,
} from "@/components/projects/inputs/inputKinds";
import { friendlyFileName } from "@/components/projects/panels/LinkRow";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type { ProjectLink } from "@/types";

/** What a row calls an input: its label, else a readable form of its ref. */
export function inputTitle(link: Pick<ProjectLink, "kind" | "ref" | "label">): string {
  if (link.label) return link.label;
  if (isNoteRef(link.ref)) return noteText(link.ref);
  if (link.kind === "file" || link.kind === "sample" || link.kind === "reference") {
    return friendlyFileName(link.ref) ?? link.ref;
  }
  return link.ref;
}

/** "Template to match · added by you · 2d ago". */
export function inputMeta(link: ProjectLink, callerUserId?: string): string {
  const who = addedByLabel(link.added_by, callerUserId);
  return [inputRoleLabel(link), who ? `added by ${who}` : null, agoLabel(link.added_at)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One input: badge, title, role · who · when, and Remove. Each row owns its
 * own `useProjectAction`, so rows lock independently and a double click
 * sends one DELETE.
 */
export function InputRow({
  slug,
  link,
  callerUserId,
  archived = false,
  onRemoved,
  onOpen,
  opening = false,
  icon,
}: {
  slug: string;
  link: ProjectLink;
  callerUserId?: string;
  archived?: boolean;
  onRemoved?: (link: ProjectLink) => void;
  /** Files open in the file viewer. */
  onOpen?: (link: ProjectLink) => void;
  opening?: boolean;
  icon?: string;
}) {
  const action = useProjectAction();
  const title = inputTitle(link);
  const unresolved = link.resolved === null;
  const href = link.kind === "url" ? link.ref : null;

  const titleNode = onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(link)}
      disabled={opening}
      aria-label={`Open ${title}`}
      className="block w-full truncate text-left text-sm font-medium disabled:opacity-60"
    >
      {title}
    </button>
  ) : href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block truncate text-sm font-medium text-[var(--color-accent)]"
    >
      {title}
    </a>
  ) : (
    <span
      className={`block truncate text-sm font-medium ${
        unresolved ? "text-[var(--color-muted)]" : ""
      }`}
    >
      {title}
    </span>
  );

  return (
    <li
      data-component="InputRow"
      data-kind={link.kind}
      className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--color-surface-2)] text-[9px] font-bold text-[var(--color-muted)]"
        >
          {icon ?? fileBadge(title)}
        </span>
        <div className="min-w-0 flex-1">
          {titleNode}
          <span className="block truncate text-xs text-[var(--color-muted)]">
            {inputMeta(link, callerUserId)}
          </span>
        </div>
        {archived ? null : (
          <ActionButton
            busy={action.busy}
            pendingLabel="Removing…"
            aria-label={`Remove ${title}`}
            onClick={() =>
              void action.run(`/api/projects/${encodeURIComponent(slug)}/links`, {
                method: "DELETE",
                body: { kind: link.kind, ref: link.ref, profile: link.profile },
                onSuccess: () => onRemoved?.(link),
              })
            }
            className="shrink-0 text-xs text-[var(--color-muted)] underline disabled:opacity-40"
          >
            Remove
          </ActionButton>
        )}
      </div>
      {action.error ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-red-400">
          {action.error}
          <ActionButton
            busy={action.busy}
            pendingLabel="Retrying…"
            onClick={() => void action.retry()}
            className="underline"
          >
            Retry
          </ActionButton>
        </p>
      ) : null}
    </li>
  );
}

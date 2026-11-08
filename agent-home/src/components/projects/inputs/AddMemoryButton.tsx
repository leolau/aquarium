"use client";

import { ActionButton } from "@/components/projects/ActionButton";
import { memoryLink, toProjectLink } from "@/components/projects/inputs/inputKinds";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type { MemoryRow, ProjectLink } from "@/types";

/**
 * Link one memory to the project. One hook per row: a double click sends
 * one POST, and the row says "Added" from the server's answer.
 */
export function AddMemoryButton({
  slug,
  row,
  projectId,
  profile,
  added,
  onAdded,
}: {
  slug: string;
  row: MemoryRow;
  projectId: string;
  profile: string;
  added: boolean;
  onAdded: (link: ProjectLink) => void;
}) {
  const action = useProjectAction<Partial<ProjectLink>>();
  if (added) {
    return <span className="shrink-0 text-xs text-emerald-500">✓ Added</span>;
  }
  const payload = memoryLink(row);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <ActionButton
        busy={action.busy}
        pendingLabel="Adding…"
        onClick={() =>
          void action.run(`/api/projects/${encodeURIComponent(slug)}/links`, {
            body: payload,
            onSuccess: (data) =>
              onAdded(toProjectLink({ ...payload, ...data }, { projectId, profile })),
          })
        }
        className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50"
      >
        Add
      </ActionButton>
      {action.error ? (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {action.error}{" "}
          <button type="button" onClick={() => void action.retry()} className="underline">
            Retry
          </button>
        </span>
      ) : null}
    </span>
  );
}

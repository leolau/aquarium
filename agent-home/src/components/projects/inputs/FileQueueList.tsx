"use client";

import {
  FILE_ROLES,
  fileBadge,
  formatBytes,
  type FileRole,
} from "@/components/projects/inputs/inputKinds";
import type { UploadItem } from "@/components/projects/inputs/useUploadQueue";

function statusLine(item: UploadItem, waitingCopy: string) {
  switch (item.status) {
    case "uploading":
      if (item.waiting) return <span>Waiting to upload…</span>;
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          Uploading {Math.round(item.progress * 100)}%…
        </span>
      );
    case "done":
      return <span className="text-emerald-500">✓ Attached</span>;
    case "failed":
      return <span className="text-red-400">✗ {item.error ?? "Upload failed."}</span>;
    default:
      return <span>{waitingCopy}</span>;
  }
}

/**
 * Picked files with their role, size and upload state. A file that is
 * uploading or attached can no longer be removed or re-roled here.
 */
export function FileQueueList({
  items,
  onRole,
  onRemove,
  onRetry,
  waitingCopy = "Ready",
}: {
  items: UploadItem[];
  onRole?: (id: string, role: FileRole) => void;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  /** What a queued file says, e.g. "Uploads when you create the project". */
  waitingCopy?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul data-component="FileQueueList" className="flex flex-col gap-1.5">
      {items.map((item) => {
        const locked = item.status === "uploading" || item.status === "done";
        return (
          <li
            key={item.id}
            data-status={item.status}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2"
          >
            <span
              aria-hidden
              className="grid h-9 w-8 shrink-0 place-items-end justify-center rounded-md bg-[var(--color-surface-2)] pb-1 text-[9px] font-bold text-[var(--color-muted)]"
            >
              {fileBadge(item.file.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.file.name}</p>
              <p className="text-xs text-[var(--color-muted)]">
                {formatBytes(item.file.size)} · {statusLine(item, waitingCopy)}
              </p>
            </div>
            {onRole ? (
              <select
                aria-label={`Use ${item.file.name} as`}
                value={item.role}
                disabled={locked}
                onChange={(e) => onRole(item.id, e.target.value as FileRole)}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs disabled:opacity-60"
              >
                {FILE_ROLES.map((role) => (
                  <option key={role.value} value={role.value}>
                    Use as: {role.label.toLowerCase()}
                  </option>
                ))}
              </select>
            ) : null}
            {item.status === "failed" && onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(item.id)}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Retry
              </button>
            ) : null}
            {onRemove && !locked ? (
              <button
                type="button"
                aria-label={`Remove ${item.file.name}`}
                onClick={() => onRemove(item.id)}
                className="px-1 text-sm text-[var(--color-muted)]"
              >
                ✕
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

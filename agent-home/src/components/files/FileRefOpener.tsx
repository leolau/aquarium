"use client";

import { useState } from "react";

import { FileDetail } from "@/components/files/FilesView";
import { friendlyFileName } from "@/components/projects/panels/LinkRow";
import { mediaContentRef } from "@/lib/chat/media-ref";
import type { FileAsset } from "@/types";
import { useAction } from "@/lib/use-action";

export interface FileRefTarget {
  /** The storage object path (`<user>/<scope>/<uuid>-<name>`). */
  ref: string;
  /** Display label — defaults to the un-slugged tail of `ref`. */
  label?: string | null;
}

/**
 * Open a `file`-kind storage ref the same way everywhere: resolve the path to
 * its registry row (`/api/files/by-path`) and show the shared `FileDetail`
 * dialog; when nothing in the registry owns the path, fall back to a dialog
 * that views/downloads straight through the media content route (which still
 * enforces the caller's principal prefix server-side).
 *
 * Usage: `const { open, resolving, dialog } = useFileRefOpener();` — call
 * `open({ ref, label })` from a click handler and render `{dialog}` near the
 * end of the section. `resolving` holds the in-flight ref for spinners.
 */
export function useFileRefOpener() {
  const [detail, setDetail] = useState<FileAsset | null>(null);
  const [fallback, setFallback] = useState<FileRefTarget | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const open = async (target: FileRefTarget) => {
    setResolving(target.ref);
    try {
      const res = await fetch(
        `/api/files/by-path?path=${encodeURIComponent(target.ref)}`,
      );
      if (res.ok) {
        setDetail((await res.json()) as FileAsset);
      } else {
        // No registry row (registration is best-effort) — direct view/download.
        setFallback(target);
      }
    } catch {
      setFallback(target);
    } finally {
      setResolving(null);
    }
  };

  const dialog = detail ? (
    <FileDetail file={detail} onClose={() => setDetail(null)} />
  ) : fallback ? (
    <FileRefFallback target={fallback} onClose={() => setFallback(null)} />
  ) : null;

  // A fast double click on a file link would fetch it twice.
  const { run: openOnce } = useAction(open);

  return { open: openOnce, resolving, dialog };
}

/** The no-registry-record dialog: view/download via the media content route. */
function FileRefFallback({
  target,
  onClose,
}: {
  target: FileRefTarget;
  onClose: () => void;
}) {
  const name = target.label ?? friendlyFileName(target.ref) ?? target.ref;
  return (
    <div
      data-component="FileFallbackDetail"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold break-all">{name}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs"
          >
            ✕
          </button>
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          No registry record for this file — opening it straight from storage.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <a
            href={mediaContentRef(target.ref)}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-[var(--color-accent)]"
          >
            View
          </a>
          <a
            href={`${mediaContentRef(target.ref)}&download=1`}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
          >
            Download
          </a>
        </div>
      </div>
    </div>
  );
}

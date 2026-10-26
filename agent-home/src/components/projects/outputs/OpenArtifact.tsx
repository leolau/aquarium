"use client";

import type { ReactNode } from "react";

import type { FileRefTarget } from "@/components/files/FileRefOpener";
import type { ProjectArtifact } from "@/types";
import { newTabRel } from "@/lib/http/link-rel";

export type OpenFile = (target: FileRefTarget) => Promise<void>;

/** A file-route href asking for a download instead of inline viewing;
 * null for external links (a Google Doc, a web page). */
export function downloadHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith("/api/")) return null;
  return `${href}${href.includes("?") ? "&" : "?"}download=1`;
}

/**
 * Open and Download for a produced file (Download only where the file's
 * bytes come through this app).
 */
export function OpenArtifact(
  props: Parameters<typeof OpenOnly>[0] & { onDownloadFile?: OpenFile },
) {
  const { file, onDownloadFile, resolving, className } = props;
  const open = <OpenOnly {...props} />;
  const label = `Download ${file.title}`;
  const cls =
    className ??
    "rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs";
  const href = downloadHref(file.href);
  let download: ReactNode = null;
  if (href) {
    download = (
      <a href={href} download aria-label={label} className={cls}>
        Download
      </a>
    );
  } else if (
    !file.href &&
    file.link_kind === "file" &&
    file.link_ref &&
    onDownloadFile
  ) {
    const ref = file.link_ref;
    download = (
      <button
        type="button"
        aria-label={label}
        onClick={() => void onDownloadFile({ ref, label: file.title })}
        disabled={resolving === ref}
        className={`${cls} disabled:opacity-50`}
      >
        Download
      </button>
    );
  }
  if (!download) return open;
  return (
    <span
      data-component="FileActions"
      className="flex shrink-0 items-center gap-1.5"
    >
      {open}
      {download}
    </span>
  );
}

/**
 * The one Open control for a produced file: a link when the file has an
 * openable URL/route, the shared file opener for a storage `file` ref, a
 * note when the file no longer exists, and a disabled button (with the
 * reason) when it cannot be reached from here.
 */
function OpenOnly({
  file,
  onOpenFile,
  resolving,
  className = "rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs",
}: {
  file: Pick<ProjectArtifact, "title" | "href" | "link_kind" | "link_ref"> &
    Partial<Pick<ProjectArtifact, "missing" | "location">>;
  onOpenFile?: OpenFile;
  resolving?: string | null;
  className?: string;
}) {
  const label = `Open ${file.title}`;
  if (file.href) {
    return (
      <a
        href={file.href}
        target="_blank"
        rel={newTabRel(file.href)}
        aria-label={label}
        className={className}
      >
        Open
      </a>
    );
  }
  if (file.link_kind === "file" && file.link_ref && onOpenFile) {
    const ref = file.link_ref;
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => void onOpenFile({ ref, label: file.title })}
        disabled={resolving === ref}
        className={`${className} disabled:opacity-50`}
      >
        {resolving === ref ? "Opening…" : "Open"}
      </button>
    );
  }
  if (file.missing) {
    const fromWorkspace = file.location?.startsWith("card workspace") ?? false;
    return (
      <span
        data-testid="file-missing"
        title={
          fromWorkspace
            ? "This file lived in its card's temporary working folder, which is cleared when the card finishes."
            : "This file is no longer on the server."
        }
        className="text-xs text-[var(--color-muted)]"
      >
        {fromWorkspace
          ? "Deleted when its card finished"
          : "No longer on the server"}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled
      aria-label={label}
      title="This file isn't reachable from here"
      className={`${className} opacity-40`}
    >
      Open
    </button>
  );
}

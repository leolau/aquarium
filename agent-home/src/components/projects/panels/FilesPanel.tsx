"use client";

import { useMemo, useState } from "react";

import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { useFileRefOpener } from "@/components/files/FileRefOpener";
import { FileDropZone } from "@/components/projects/inputs/FileDropZone";
import { FileQueueList } from "@/components/projects/inputs/FileQueueList";
import { InputRow } from "@/components/projects/inputs/InputRow";
import {
  DEFAULT_FILE_ROLE,
  FILE_ROLES,
  groupInputLinks,
  toProjectLink,
  upsertLink,
  withoutLink,
  type FileRole,
} from "@/components/projects/inputs/inputKinds";
import type { UploadFn } from "@/components/projects/inputs/uploadProjectFile";
import { useUploadQueue } from "@/components/projects/inputs/useUploadQueue";
import { useRefresh, useServerState } from "@/components/ui/useRefresh";
import type { ProjectDetail, ProjectLink } from "@/types";

/**
 * The project's files (§11.1): uploads and pointers, each with its role —
 * a template to match (`sample`) or a reference to read (`reference`) —
 * plus who added it and when. Files dropped here upload straight away, one
 * request per file (a second drop of the same file is ignored); a failed
 * upload stays in the list with Retry, which re-sends the same key.
 */
export function FilesPanel({
  project,
  archived = false,
  callerUserId,
  upload,
}: {
  project: ProjectDetail;
  archived?: boolean;
  callerUserId?: string;
  /** Test seam: the upload transport. */
  upload?: UploadFn;
}) {
  const fromServer = useMemo(() => groupInputLinks(project.links).files, [project.links]);
  const [files, setFiles] = useServerState<ProjectLink[]>(fromServer);
  const [role, setRole] = useState<FileRole>(DEFAULT_FILE_ROLE);
  const [sheetOpen, setSheetOpen] = useState(false);
  const fileOpener = useFileRefOpener();
  const { refresh } = useRefresh();
  const slug = project.slug;
  const profile = project.host_profile ?? "default";

  const queue = useUploadQueue({
    upload,
    autoUploadSlug: archived ? undefined : slug,
    dropDone: true,
    onUploaded: (link) => {
      setFiles((prev) =>
        upsertLink(prev, toProjectLink(link, { projectId: project.id, profile, addedBy: callerUserId })),
      );
      refresh();
    },
  });

  return (
    <section
      id="panel-files"
      data-component="FilesPanel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div>
        <h2 className="text-sm font-semibold">📎 Files</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Templates to match · references to read
        </p>
      </div>

      {files.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          No files yet. Add an earlier version, a template or anything the
          agent should read — runs can also add their own.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {files.map((link) => (
            <InputRow
              key={`${link.kind}:${link.profile}:${link.ref}`}
              slug={slug}
              link={link}
              callerUserId={callerUserId}
              archived={archived}
              onRemoved={(gone) => setFiles((prev) => withoutLink(prev, gone))}
              onOpen={
                link.kind === "file" || link.kind === "sample" || link.kind === "reference"
                  ? (l) => void fileOpener.open({ ref: l.ref, label: l.label })
                  : undefined
              }
              onDownload={
                link.kind === "file" || link.kind === "sample" || link.kind === "reference"
                  ? (l) => void fileOpener.download({ ref: l.ref, label: l.label })
                  : undefined
              }
              opening={fileOpener.resolving === link.ref}
            />
          ))}
        </ul>
      )}

      <FileQueueList
        items={queue.items}
        onRemove={queue.remove}
        onRetry={(id) => void queue.retry(id, slug)}
      />

      {archived ? (
        <p className="text-xs text-[var(--color-muted)]">
          This project is archived — restore it (⋯) to add files.
        </p>
      ) : (
        <>
          <label className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
            New files are
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as FileRole)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text)]"
            >
              {FILE_ROLES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <FileDropZone
            compact
            hint="Drop files to add them to the project"
            chooseLabel="Upload file"
            onFiles={(picked) => queue.add(picked, role)}
          />
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="self-start rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)]"
          >
            Add link
          </button>
        </>
      )}

      {sheetOpen ? (
        <AddToProjectSheet
          onClose={() => {
            setSheetOpen(false);
            refresh();
          }}
          fixedSlug={slug}
          fixedName={project.name}
          prefill={{ kind: "file" }}
        />
      ) : null}

      {fileOpener.dialog}
    </section>
  );
}

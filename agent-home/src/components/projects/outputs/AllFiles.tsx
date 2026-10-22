"use client";

import { useState } from "react";

import { dateTimeLabel } from "@/components/projects/format";
import { newestFirst, provenanceLabel } from "@/components/projects/outputs/artifacts";
import { FileBadge } from "@/components/projects/outputs/FileBadge";
import { OpenArtifact, type OpenFile } from "@/components/projects/outputs/OpenArtifact";
import { Pill, type Tone } from "@/components/ui/Pill";
import type { ProjectArtifact, ProjectArtifactKind } from "@/types";

const KIND_LABEL: Record<ProjectArtifactKind, string> = {
  deliverable: "final",
  draft: "draft",
  note: "working note",
};
const KIND_TONE: Record<ProjectArtifactKind, Tone> = {
  deliverable: "success",
  draft: "warning",
  note: "muted",
};

type Filter = "all" | ProjectArtifactKind;
const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["deliverable", "Final"],
  ["draft", "Drafts"],
  ["note", "Notes"],
];

/**
 * Every produced file — final deliverables, intermediate drafts and working
 * notes from cards — with the run/card it came from, so nobody has to open
 * a run page or a card to find one.
 */
export function AllFiles({
  artifacts,
  loading,
  fallback,
  onOpenFile,
  onDownloadFile,
  resolving,
}: {
  artifacts: ProjectArtifact[];
  loading: boolean;
  fallback: boolean;
  onOpenFile?: OpenFile;
  onDownloadFile?: OpenFile;
  resolving?: string | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = newestFirst(artifacts.filter((a) => filter === "all" || a.kind === filter));
  return (
    <section
      data-component="AllFiles"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        All files · drafts &amp; working notes
      </h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Final deliverables, intermediate drafts and working notes from every run and card.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Filter files">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={`rounded-full px-2.5 py-1 text-xs ${
              filter === key
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "bg-[var(--color-surface-2)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {fallback ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Couldn&apos;t load drafts and notes right now — showing delivered files only.
        </p>
      ) : null}
      {loading ? (
        <ul data-component="FilesSkeleton" aria-busy="true" className="mt-3 flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-11 animate-pulse rounded-lg bg-[var(--color-surface-2)]" />
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          {filter === "all" ? "No files produced yet." : "Nothing here yet."}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {rows.map((file) => (
            <li
              key={file.id}
              data-component="FileRow"
              data-kind={file.kind}
              className="flex items-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-2 py-1.5"
            >
              <FileBadge file={file} />
              <span className="min-w-0 flex-1">
                <span className="block break-all text-sm">{file.title}</span>
                <span className="block truncate text-xs text-[var(--color-muted)]">
                  {provenanceLabel(file)} · {dateTimeLabel(file.created_at)}
                </span>
              </span>
              <Pill tone={KIND_TONE[file.kind]}>{KIND_LABEL[file.kind]}</Pill>
              <OpenArtifact file={file} onOpenFile={onOpenFile} onDownloadFile={onDownloadFile} resolving={resolving} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

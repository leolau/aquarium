"use client";

import { useFileRefOpener } from "@/components/files/FileRefOpener";
import { latestShelfItems, middleEllipsize } from "@/components/projects/outputs/artifacts";
import { FileBadge } from "@/components/projects/outputs/FileBadge";
import { OpenArtifact } from "@/components/projects/outputs/OpenArtifact";
import { useProjectArtifacts } from "@/components/projects/outputs/useProjectArtifacts";
import { Pill } from "@/components/ui/Pill";
import type { ProjectArtifact, ProjectDetail, ProjectOutputStatus } from "@/types";

function tilePill(
  file: ProjectArtifact,
  statusOf: Map<string, ProjectOutputStatus>,
): { label: string; tone: "warning" | "accent" | "success" | "muted" } {
  if (file.kind === "draft") return { label: "draft", tone: "warning" };
  const status = file.output_id ? statusOf.get(file.output_id) : undefined;
  if (status === "in_progress") return { label: "writing", tone: "accent" };
  if (status === "accepted") return { label: "accepted", tone: "success" };
  return { label: file.version ? `v${file.version}` : "delivered", tone: "muted" };
}

/**
 * The dashboard's "Latest outputs" shelf: newest deliverables and drafts,
 * each one click from opening.
 */
export function LatestOutputsShelf({
  project,
  onShowAll,
  initialArtifacts,
  fetchImpl,
}: {
  project: ProjectDetail;
  onShowAll: () => void;
  /** Prefetched list (skips the client read). */
  initialArtifacts?: ProjectArtifact[];
  fetchImpl?: typeof fetch;
}) {
  const { artifacts, loading } = useProjectArtifacts(project.slug, project.outputs, {
    initial: initialArtifacts,
    fetchImpl,
  });
  const opener = useFileRefOpener();
  const tiles = latestShelfItems(artifacts);
  const statusOf = new Map(project.outputs.map((o) => [o.id, o.status]));

  return (
    <section
      data-component="LatestOutputsShelf"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Latest outputs
        </h2>
        <button
          type="button"
          onClick={onShowAll}
          className="text-xs text-[var(--color-accent)]"
        >
          All outputs &amp; drafts ›
        </button>
      </div>
      {loading ? (
        <ul data-component="ShelfSkeleton" aria-busy="true" className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="h-16 animate-pulse rounded-xl bg-[var(--color-surface-2)]" />
          ))}
        </ul>
      ) : tiles.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Nothing produced yet. Files from runs and cards will show up here.
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {tiles.map((file) => {
            const pill = tilePill(file, statusOf);
            const where = [file.run_no != null ? `Run ${file.run_no}` : null, file.location]
              .filter(Boolean)
              .join(" · ");
            return (
              <li
                key={file.id}
                data-component="OutputTile"
                className="flex items-center gap-2 rounded-xl bg-[var(--color-surface-2)] p-2"
              >
                <FileBadge file={file} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" title={file.title}>
                    {middleEllipsize(file.title)}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                    <span className="truncate">{where || file.output_title || ""}</span>
                  </span>
                </span>
                <OpenArtifact file={file} onOpenFile={opener.open}
          onDownloadFile={opener.download} resolving={opener.resolving} />
              </li>
            );
          })}
        </ul>
      )}
      {opener.dialog}
    </section>
  );
}

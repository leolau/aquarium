"use client";

import { useState } from "react";

import { useFileRefOpener } from "@/components/files/FileRefOpener";
import { applyAcceptEnvelope } from "@/components/projects/envelopes";
import { AddOutputForm } from "@/components/projects/outputs/AddOutputForm";
import { AllFiles } from "@/components/projects/outputs/AllFiles";
import { ClosureOffer } from "@/components/projects/outputs/ClosureOffer";
import { DeliverableCard, type AcceptEnvelope } from "@/components/projects/outputs/DeliverableCard";
import { UnattachedWarning, type AttachResult } from "@/components/projects/outputs/UnattachedWarning";
import { outputsAwaitingDelivery } from "@/components/projects/outputs/artifacts";
import { useProjectArtifacts } from "@/components/projects/outputs/useProjectArtifacts";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { useServerState } from "@/components/ui/useRefresh";
import type { ProjectArtifact, ProjectOutputWithDeliveries } from "@/types";

/** Undelivered required outputs first, then required, then the rest;
 * superseded ones last. */
function rank(o: ProjectOutputWithDeliveries): number {
  if (o.status === "dropped") return 3;
  if (o.required && o.status !== "accepted" && o.status !== "delivered") return 0;
  return o.required ? 1 : 2;
}

/**
 * The Outputs tab: the declared deliverables with their versions and verbs,
 * a warning for produced files no output owns, and every file (final,
 * draft, working note) one tap from opening.
 */
export function OutputsTab({
  project,
  onChangeRequest,
  initialArtifacts,
  fetchImpl,
}: ProjectTabProps & {
  /** Prefetched artifacts (skips the client read). */
  initialArtifacts?: ProjectArtifact[];
  fetchImpl?: typeof fetch;
}) {
  const [outputs, setOutputs] = useServerState(project.outputs);
  const files = useProjectArtifacts(project.slug, outputs, {
    initial: initialArtifacts,
    fetchImpl,
  });
  const opener = useFileRefOpener();
  const [offersClosure, setOffersClosure] = useState(false);
  const archived = project.archived;
  const sorted = [...outputs].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
  // With every output delivered, files no output owns are just working
  // files: list them after the result instead of above it.
  const workingFilesOnly =
    outputsAwaitingDelivery(outputs).length === 0 && outputs.some((o) => o.status !== "dropped");

  const onAccepted = (outputId: string, envelope: AcceptEnvelope) => {
    setOutputs((prev) => applyAcceptEnvelope(prev, outputId, envelope).outputs);
    if (envelope.offers_closure === true) setOffersClosure(true);
  };
  const onUpdated = (row: Partial<ProjectOutputWithDeliveries> & { id: string }) => {
    const { deliveries: _ignored, ...rest } = row;
    void _ignored;
    setOutputs((prev) => prev.map((o) => (o.id === row.id ? { ...o, ...rest } : o)));
  };
  const onRemoved = (outputId: string) =>
    setOutputs((prev) => prev.filter((o) => o.id !== outputId));
  const onAttached = (file: ProjectArtifact, result: AttachResult) => {
    const target = outputs.find((o) => o.id === result.output_id);
    const now = Math.floor(Date.now() / 1000);
    setOutputs((prev) =>
      prev.map((o) =>
        o.id === result.output_id
          ? {
              ...o,
              status: o.status === "accepted" ? o.status : "delivered",
              delivered_at: now,
              deliveries: [
                ...o.deliveries,
                {
                  id: result.delivery_id,
                  output_id: o.id,
                  run_id: file.run_id,
                  task_id: file.card_id,
                  link_kind: file.link_kind,
                  link_ref: file.link_ref,
                  profile: file.created_by,
                  label: file.title,
                  note: null,
                  delivered_at: now,
                },
              ],
            }
          : o,
      ),
    );
    files.setArtifacts((prev) =>
      prev.map((a) =>
        a.id === file.id
          ? {
              ...a,
              id: `d:${result.delivery_id}`,
              kind: "deliverable",
              output_id: result.output_id,
              output_title: target?.title ?? null,
            }
          : a,
      ),
    );
    files.reload();
  };

  const unattached = (
    <UnattachedWarning
      slug={project.slug}
      artifacts={files.artifacts}
      outputs={outputs}
      archived={archived}
      onAttached={onAttached}
      onOpenFile={opener.open}
      onDownloadFile={opener.download}
      resolving={opener.resolving}
    />
  );

  return (
    <div data-component="OutputsTab" className="flex flex-col gap-4">
      {!files.loading && !workingFilesOnly ? unattached : null}

      <section data-component="Deliverables" className="flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Final outputs</h2>
        <p className="text-xs text-[var(--color-muted)]">
          The result of this project: each output, the files delivered for it per run, and
          what you can do with it.
        </p>
        {archived ? (
          <p className="text-xs text-[var(--color-muted)]">
            This project is archived — restore it (⋯) to accept outputs.
          </p>
        ) : null}
        {offersClosure ? (
          <ClosureOffer slug={project.slug} onDismiss={() => setOffersClosure(false)} />
        ) : null}
        {sorted.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No outputs yet. Add one below — the deliverable is what a run is
            accountable to, and what you accept when it is done.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {sorted.map((output) => (
              <DeliverableCard
                key={output.id}
                slug={project.slug}
                output={output}
                artifacts={files.artifacts}
                archived={archived}
                onAccepted={onAccepted}
                onUpdated={onUpdated}
                onRemoved={onRemoved}
                onChangeRequest={onChangeRequest}
                onOpenFile={opener.open}
          onDownloadFile={opener.download}
                resolving={opener.resolving}
              />
            ))}
          </ul>
        )}
        {!archived ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-3">
            <AddOutputForm
              slug={project.slug}
              onAdded={(row) => setOutputs((prev) => [...prev, row])}
            />
          </div>
        ) : null}
      </section>

      {!files.loading && workingFilesOnly ? (
        <section data-component="WorkingFiles" className="flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Working files (not the result)
          </h2>
          <p className="text-xs text-[var(--color-muted)]">
            Drafts, notes and data the cards produced on the way to the final outputs.
          </p>
          {unattached}
        </section>
      ) : null}

      <AllFiles
        artifacts={files.artifacts}
        loading={files.loading}
        fallback={files.fallback}
        onOpenFile={opener.open}
          onDownloadFile={opener.download}
        resolving={opener.resolving}
      />
      {opener.dialog}
    </div>
  );
}

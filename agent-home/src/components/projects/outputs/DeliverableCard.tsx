"use client";

import { ActionButton } from "@/components/projects/ActionButton";
import { dateTimeLabel } from "@/components/projects/format";
import { ActionError } from "@/components/projects/outputs/ActionError";
import {
  decodeEscapes,
  deliveryTitle,
  groupVersions,
  outputStateLabel,
  versionLabel,
} from "@/components/projects/outputs/artifacts";
import { FileBadge } from "@/components/projects/outputs/FileBadge";
import { OpenArtifact, type OpenFile } from "@/components/projects/outputs/OpenArtifact";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { Pill, type Tone } from "@/components/ui/Pill";
import type {
  ProjectArtifact,
  ProjectOutputStatus,
  ProjectOutputWithDeliveries,
} from "@/types";

const STATUS_TONE: Record<ProjectOutputStatus, Tone> = {
  pending: "muted",
  in_progress: "accent",
  delivered: "warning",
  accepted: "success",
  dropped: "danger",
};

export interface AcceptEnvelope {
  output?: Partial<ProjectOutputWithDeliveries>;
  offers_closure?: boolean;
}

/**
 * One declared output with everything about it in one place: its state,
 * the decoded spec, each version (one per run) with its files, and the
 * verbs — Accept · Request changes · Mark superseded. Each verb has its own
 * action lock, so this card's buttons never wait on another card's.
 */
export function DeliverableCard({
  slug,
  output,
  artifacts,
  archived,
  onAccepted,
  onUpdated,
  onRemoved,
  onChangeRequest,
  onOpenFile,
  onDownloadFile,
  resolving,
}: {
  slug: string;
  output: ProjectOutputWithDeliveries;
  artifacts: ProjectArtifact[];
  archived: boolean;
  onAccepted: (outputId: string, envelope: AcceptEnvelope) => void;
  onUpdated: (row: Partial<ProjectOutputWithDeliveries> & { id: string }) => void;
  onRemoved: (outputId: string) => void;
  onChangeRequest?: (text?: string) => void;
  onOpenFile?: OpenFile;
  onDownloadFile?: OpenFile;
  resolving?: string | null;
}) {
  const accept = useProjectAction<AcceptEnvelope>();
  const supersede = useProjectAction<ProjectOutputWithDeliveries>();
  const remove = useProjectAction<{ deleted: string }>();
  const base = `/api/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(output.id)}`;
  const versions = groupVersions(output, artifacts);
  const latest = versions[0];
  const title = decodeEscapes(output.title);
  const spec = decodeEscapes(output.spec);
  const anyBusy = accept.busy || supersede.busy || remove.busy;

  return (
    <li
      data-component="DeliverableCard"
      data-output-id={output.id}
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{title}</span>
        <Pill>{output.required ? "required" : "optional"}</Pill>
        <Pill tone={STATUS_TONE[output.status]}>
          <span data-testid="output-state">
            {outputStateLabel(output.status)}
            {latest && output.status !== "dropped" ? ` · v${latest.version}` : ""}
          </span>
        </Pill>
      </div>
      {spec ? <p className="mt-1 text-xs text-[var(--color-muted)]">{spec}</p> : null}

      {versions.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">Nothing delivered yet.</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2">
          {versions.map((v) => (
            <li key={`${v.version}`} data-component="OutputVersion">
              <p className="text-xs text-[var(--color-muted)]">
                {versionLabel(v)} · {dateTimeLabel(v.deliveredAt)}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {v.files.map(({ delivery, artifact }) => {
                  const name = artifact?.title ?? deliveryTitle(delivery, title);
                  const file = artifact ?? {
                    title: name,
                    href:
                      delivery.link_kind === "url" || /^https?:\/\//i.test(delivery.link_ref ?? "")
                        ? delivery.link_ref
                        : null,
                    link_kind: delivery.link_kind,
                    link_ref: delivery.link_ref,
                    ext: null,
                    mime: null,
                  };
                  return (
                    <li
                      key={delivery.id}
                      className="flex items-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-2 py-1.5"
                    >
                      <FileBadge file={{ ...file, title: name }} />
                      <span className="min-w-0 flex-1 break-all text-sm" title={name}>
                        {name}
                      </span>
                      {output.status !== "dropped" ? (
                        <Pill tone="accent">
                          <span data-testid="final-output-badge">Final output</span>
                        </Pill>
                      ) : null}
                      {delivery.link_ref || artifact?.href ? (
                        <OpenArtifact file={{ ...file, title: name }} onOpenFile={onOpenFile} onDownloadFile={onDownloadFile} resolving={resolving} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {output.status === "accepted" && output.accepted_at != null ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          accepted {dateTimeLabel(output.accepted_at)}
          {output.accepted_by ? ` by ${output.accepted_by}` : ""}
        </p>
      ) : null}

      {!archived && output.status !== "dropped" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {output.status === "delivered" ? (
            <ActionButton
              busy={accept.busy}
              pendingLabel="Accepting…"
              disabled={anyBusy}
              onClick={() =>
                void accept.run(`${base}/accept`, {
                  onSuccess: (data) => onAccepted(output.id, data),
                })
              }
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              Accept
            </ActionButton>
          ) : null}
          {onChangeRequest ? (
            <button
              type="button"
              onClick={() => onChangeRequest(`Change output ${title}: `)}
              disabled={anyBusy}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Request changes…
            </button>
          ) : null}
          {output.status !== "pending" || output.deliveries.length > 0 ? (
            <ActionButton
              busy={supersede.busy}
              pendingLabel="Marking superseded…"
              disabled={anyBusy}
              onClick={() =>
                void supersede.run(base, {
                  method: "PATCH",
                  body: { status: "dropped" },
                  onSuccess: (row) => onUpdated({ ...row, id: output.id }),
                })
              }
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-muted)] disabled:opacity-50"
            >
              Mark superseded
            </ActionButton>
          ) : (
            <ActionButton
              busy={remove.busy}
              pendingLabel="Removing…"
              disabled={anyBusy}
              onClick={() =>
                void remove.run(base, {
                  method: "DELETE",
                  onSuccess: () => onRemoved(output.id),
                })
              }
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-muted)] disabled:opacity-50"
            >
              Remove
            </ActionButton>
          )}
        </div>
      ) : null}
      {output.status === "delivered" && !archived ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Delivered — waiting for you to judge it met the spec. Accepting is a human act; the agent cannot do it for you.
        </p>
      ) : null}
      <ActionError action={accept} />
      <ActionError action={supersede} />
      <ActionError action={remove} />
    </li>
  );
}

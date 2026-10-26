"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { applyAcceptEnvelope } from "@/components/projects/envelopes";
import { dateTimeLabel } from "@/components/projects/format";
import { useFileRefOpener } from "@/components/files/FileRefOpener";
import { ActionError } from "@/components/projects/outputs/ActionError";
import { AddOutputForm } from "@/components/projects/outputs/AddOutputForm";
import { ClosureOffer } from "@/components/projects/outputs/ClosureOffer";
import { decodeEscapes, outputStateLabel } from "@/components/projects/outputs/artifacts";
import { friendlyFileName } from "@/components/projects/panels/LinkRow";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { Pill } from "@/components/ui/Pill";
import { useServerState } from "@/components/ui/useRefresh";
import type {
  ProjectDelivery,
  ProjectOutputStatus,
  ProjectOutputWithDeliveries,
} from "@/types";
import { newTabRel } from "@/lib/http/link-rel";

const STATUS_TONE: Record<
  ProjectOutputStatus,
  "muted" | "accent" | "success" | "warning" | "danger"
> = {
  pending: "muted",
  in_progress: "accent",
  delivered: "warning",
  accepted: "success",
  dropped: "danger",
};

interface AcceptEnvelope {
  output?: Partial<ProjectOutputWithDeliveries>;
  offers_closure?: boolean;
}

/**
 * The deliverables (§6.1). Undelivered required ones lead, because they are
 * what stands between the project and done. **Accept lives here and nowhere
 * else** — accepting is the judgement that an output met its spec, and one
 * place for a judgement keeps it honest.
 */
export function OutputsPanel({
  slug,
  outputs: initial,
  archived = false,
}: {
  slug: string;
  outputs: ProjectOutputWithDeliveries[];
  /** §13: a shelved project offers restore as the only write. */
  archived?: boolean;
}) {
  const [outputs, setOutputs] = useServerState(initial);
  const fileOpener = useFileRefOpener();
  const [offersClosure, setOffersClosure] = useState(false);

  const onAccepted = (outputId: string, payload: AcceptEnvelope) => {
    // The accept route answers with the updated row + the closure offer;
    // merge the row (the joined deliveries survive the spread) so the
    // Accept button disappears without a reload.
    setOutputs((prev) => applyAcceptEnvelope(prev, outputId, payload).outputs);
    if (payload.offers_closure === true) setOffersClosure(true);
  };

  const rank = (output: ProjectOutputWithDeliveries) =>
    // Undelivered required outputs first, then required, then the rest.
    output.required && output.status !== "accepted" && output.status !== "delivered"
      ? 0
      : output.required
        ? 1
        : 2;
  const sorted = [...outputs].sort(
    (a, b) => rank(a) - rank(b) || a.seq - b.seq,
  );

  return (
    <section
      id="panel-outputs"
      data-component="OutputsPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Outputs
      </h2>

      {archived ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          This project is archived — restore it (⋯) to accept outputs.
        </p>
      ) : null}

      {offersClosure ? (
        <ClosureOffer slug={slug} onDismiss={() => setOffersClosure(false)} />
      ) : null}

      {sorted.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          No outputs yet. Add one below — the deliverable is what a run is
          accountable to, and what you accept when it is done.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">
          {sorted.map((output) => (
            <OutputRow
              key={output.id}
              slug={slug}
              output={output}
              archived={archived}
              onAccepted={onAccepted}
              onRemoved={(id) => setOutputs((prev) => prev.filter((o) => o.id !== id))}
              onOpenFile={fileOpener.open}
              resolving={fileOpener.resolving}
            />
          ))}
        </ul>
      )}

      {!archived ? (
        <div className="mt-3">
          <AddOutputForm
            slug={slug}
            onAdded={(row) => setOutputs((prev) => [...prev, row])}
          />
        </div>
      ) : null}

      {fileOpener.dialog}
    </section>
  );
}

/** One output row; its Accept / Remove hold their own lock. */
function OutputRow({
  slug,
  output,
  archived,
  onAccepted,
  onRemoved,
  onOpenFile,
  resolving,
}: {
  slug: string;
  output: ProjectOutputWithDeliveries;
  archived: boolean;
  onAccepted: (outputId: string, payload: AcceptEnvelope) => void;
  onRemoved: (outputId: string) => void;
  onOpenFile: (target: { ref: string; label?: string | null }) => Promise<void>;
  resolving: string | null;
}) {
  const accept = useProjectAction<AcceptEnvelope>();
  const remove = useProjectAction<{ deleted: string }>();
  const base = `/api/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(output.id)}`;
  const spec = decodeEscapes(output.spec);
  return (
    <li
      data-component="OutputRow"
      className="rounded-lg bg-[var(--color-surface-2)] p-3"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {decodeEscapes(output.title)}
        </span>
        <span className="text-xs text-[var(--color-muted)]">
          {output.required ? "required" : "optional"}
        </span>
        <Pill tone={STATUS_TONE[output.status]}>
          {outputStateLabel(output.status)}
        </Pill>
      </div>
      {spec ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{spec}</p>
      ) : null}
      {output.deliveries.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {output.deliveries.map((delivery) => (
            <li key={delivery.id}>
              delivered{" "}
              {delivery.run_id ? `on a run` : "by hand"}
              <DeliveryRef
                delivery={delivery}
                onOpenFile={onOpenFile}
                resolving={resolving}
              />{" "}
              · {dateTimeLabel(delivery.delivered_at)}
            </li>
          ))}
        </ul>
      ) : null}
      {output.status === "delivered" && !archived ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ActionButton
            busy={accept.busy}
            pendingLabel="Accepting…"
            onClick={() =>
              void accept.run(`${base}/accept`, {
                onSuccess: (data) => onAccepted(output.id, data),
              })
            }
            className="rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] disabled:opacity-40"
          >
            Accept
          </ActionButton>
          <span className="text-xs text-[var(--color-muted)]">
            Delivered — waiting for you to judge it met the spec. Accepting is
            a human act; the agent cannot do it for you.
          </span>
        </div>
      ) : null}
      {output.status === "accepted" && output.accepted_at != null ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          accepted {dateTimeLabel(output.accepted_at)}
          {output.accepted_by ? ` by ${output.accepted_by}` : ""}
        </p>
      ) : null}
      {output.status === "pending" && !archived ? (
        <ActionButton
          busy={remove.busy}
          pendingLabel="Removing…"
          onClick={() =>
            void remove.run(base, {
              method: "DELETE",
              onSuccess: () => onRemoved(output.id),
            })
          }
          className="mt-2 text-xs text-[var(--color-muted)] underline disabled:opacity-40"
        >
          Remove
        </ActionButton>
      ) : null}
      <ActionError action={accept} />
      <ActionError action={remove} />
    </li>
  );
}

/**
 * The artefact pointer on one delivery row. A `file` ref resolves through the
 * shared registry/storage opener so the reviewer can actually view or
 * download what they are about to accept; a `url` ref is a plain external
 * link; anything else keeps its cached label (a link is never an authority —
 * §11 rule 5).
 */
function DeliveryRef({
  delivery,
  onOpenFile,
  resolving,
}: {
  delivery: ProjectDelivery;
  onOpenFile: (target: { ref: string; label?: string | null }) => Promise<void>;
  resolving: string | null;
}) {
  const ref = delivery.link_ref;
  const label =
    delivery.label ??
    (delivery.link_kind === "file" && ref
      ? (friendlyFileName(ref) ?? ref)
      : ref) ??
    null;

  if (delivery.link_kind === "file" && ref) {
    return (
      <>
        {" → "}
        <button
          type="button"
          onClick={() => void onOpenFile({ ref, label: delivery.label })}
          disabled={resolving === ref}
          aria-label={`Open ${label}`}
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)] disabled:opacity-50"
        >
          {label}
        </button>
      </>
    );
  }
  if (delivery.link_kind === "url" && ref) {
    return (
      <>
        {" → "}
        <a
          href={ref}
          target="_blank"
          rel={newTabRel(ref)}
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
        >
          {label}
        </a>
      </>
    );
  }
  return label ? <> → {label}</> : null;
}

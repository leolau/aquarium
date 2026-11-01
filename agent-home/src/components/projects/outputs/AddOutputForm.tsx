"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/outputs/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type { ProjectOutputKind, ProjectOutputWithDeliveries } from "@/types";

const KINDS: ProjectOutputKind[] = ["artifact", "file", "message", "decision", "report", "code"];

/** Declare a new output. Shows the server's row as soon as it answers. */
export function AddOutputForm({
  slug,
  onAdded,
}: {
  slug: string;
  onAdded: (row: ProjectOutputWithDeliveries) => void;
}) {
  const action = useProjectAction<ProjectOutputWithDeliveries>();
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [kind, setKind] = useState<ProjectOutputKind>("artifact");
  const [required, setRequired] = useState(true);

  const add = () => {
    const t = title.trim();
    if (!t) return;
    void action.run(`/api/projects/${encodeURIComponent(slug)}/outputs`, {
      body: { title: t, spec: spec.trim() || undefined, kind, required },
      onSuccess: (row) => {
        onAdded({ ...row, deliveries: [] });
        setTitle("");
        setSpec("");
        setKind("artifact");
        setRequired(true);
      },
    });
  };

  const input =
    "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";
  return (
    <div id="add-output" data-component="AddOutputForm" className="flex flex-col gap-1.5">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Output title (e.g. Course handbook)"
        aria-label="Output title"
        disabled={action.busy}
        className={input}
      />
      <input
        value={spec}
        onChange={(e) => setSpec(e.target.value)}
        placeholder="Spec — what 'good' looks like (optional)"
        aria-label="Output spec"
        disabled={action.busy}
        className={input}
      />
      <div className="flex items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ProjectOutputKind)}
          aria-label="Output kind"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          required
        </label>
        <ActionButton
          busy={action.busy}
          pendingLabel="Adding…"
          onClick={add}
          disabled={!title.trim()}
          className="ml-auto rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] disabled:opacity-40"
        >
          Add output
        </ActionButton>
      </div>
      <ActionError action={action} />
    </div>
  );
}

"use client";

import { useState } from "react";

import { agoLabel } from "@/components/projects/format";
import { prependDirective } from "@/components/projects/envelopes";
import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { useAction } from "@/lib/use-action";
import type { ProjectDirective, ProjectDirectivesResponse } from "@/types";

/**
 * Standing instructions, newest-first (§5). The add field says what the rule
 * is — *applies from the next run* — because guidance never applies
 * mid-conversation. Retired instructions live behind a disclosure rather
 * than disappearing: the audit trail is the point.
 */
export function GuidancePanel({
  slug,
  initial,
  archived = false,
}: {
  slug: string;
  initial: ProjectDirectivesResponse | null;
  /** §13: a shelved project offers restore as the only write. */
  archived?: boolean;
}) {
  const [directives, setDirectives] = useState<ProjectDirective[]>(
    initial?.directives ?? [],
  );
  const [proposed, setProposed] = useState<ProjectDirective[]>(
    initial?.proposed ?? [],
  );
  const [draft, setDraft] = useState("");
  const addAction = useProjectAction<ProjectDirective & { applies_from?: string }>();
  const [retired, setRetired] = useState<ProjectDirective[] | null>(null);
  const [loadingRetired, setLoadingRetired] = useState(false);

  const add = () => {
    const body = draft.trim();
    if (!body) return;
    void addAction.run(`/api/projects/${encodeURIComponent(slug)}/directives`, {
      body: { body },
      skipRefresh: true,
      // The full new row — body, author, date — with `applies_from` riding
      // flat beside it; prepend it so the instruction shows without a reload.
      onSuccess: (created) => {
        setDirectives((prev) => prependDirective(prev, created));
        setDraft("");
      },
    });
  };

  const directivePath = (directiveId: string, verb: "retire" | "activate") =>
    `/api/projects/${encodeURIComponent(slug)}/directives/${encodeURIComponent(directiveId)}/${verb}`;

  const loadRetired = async () => {
    setLoadingRetired(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/directives?include_retired=true`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error("load");
      const body = (await res.json()) as ProjectDirectivesResponse;
      setRetired(body.directives.filter((row) => !row.active));
    } catch {
      setRetired([]);
    } finally {
      setLoadingRetired(false);
    }
  };

  const { run: loadRetiredOnce } = useAction(loadRetired);

  return (
    <section
      id="panel-guidance"
      data-component="GuidancePanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Guidance
      </h2>

      {initial == null ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Guidance is unavailable right now.
        </p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col gap-2">
            {directives.map((directive) => (
              <li
                key={directive.id}
                data-component="DirectiveRow"
                className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
              >
                <p>{directive.body}</p>
                <p className="mt-1 flex items-center justify-between text-xs text-[var(--color-muted)]">
                  <span>
                    {directive.author_user_id} ·{" "}
                    {agoLabel(directive.created_at)}
                    {directive.kind === "feedback" ? " · feedback" : ""}
                  </span>
                  {archived ? null : (
                    <DirectiveAction
                      path={directivePath(directive.id, "retire")}
                      label="Retire"
                      pendingLabel="Retiring…"
                      className="text-[var(--color-muted)] underline disabled:opacity-50"
                      onDone={() =>
                        setDirectives((prev) => prev.filter((row) => row.id !== directive.id))
                      }
                    />
                  )}
                </p>
              </li>
            ))}
            {directives.length === 0 ? (
              <li className="text-sm text-[var(--color-muted)]">
                No standing instructions yet — add one below and every run
                reads it before it starts.
              </li>
            ) : null}
          </ul>

          {proposed.length > 0 ? (
            <div className="mt-3" data-component="ProposedDirectives">
              <h3 className="text-xs font-medium text-[var(--color-muted)]">
                Proposed by runs — inactive until you activate
              </h3>
              <ul className="mt-1.5 flex flex-col gap-2">
                {proposed.map((directive) => (
                  <li
                    key={directive.id}
                    className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                  >
                    <p>{directive.body}</p>
                    <p className="mt-1 flex items-center justify-between text-xs text-[var(--color-muted)]">
                      <span>
                        {directive.author_user_id} ·{" "}
                        {agoLabel(directive.created_at)}
                      </span>
                      {archived ? null : (
                        <DirectiveAction
                          path={directivePath(directive.id, "activate")}
                          label="Activate"
                          pendingLabel="Activating…"
                          className="text-[var(--color-accent)] underline disabled:opacity-50"
                          onDone={() => {
                            setProposed((prev) => prev.filter((p) => p.id !== directive.id));
                            setDirectives((prev) => [
                              { ...directive, active: 1 },
                              ...prev.filter((row) => row.id !== directive.id),
                            ]);
                          }}
                        />
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}


          {archived ? (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              This project is archived — restore it (⋯) to add guidance.
            </p>
          ) : (
            <BusyRegion busy={addAction.busy} label="Adding instruction…" className="mt-3">
              <div className="flex flex-col gap-1.5">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Add an instruction…"
                  rows={2}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--color-muted)]">
                    {initial.applies_from}
                  </span>
                  <ActionButton
                    busy={addAction.busy}
                    pendingLabel="Adding…"
                    onClick={add}
                    disabled={!draft.trim()}
                    className="rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] disabled:opacity-40"
                  >
                    Add
                  </ActionButton>
                </div>
                <ActionError action={addAction} />
              </div>
            </BusyRegion>
          )}

          {retired == null ? (
            <ActionButton
              busy={loadingRetired}
              pendingLabel="Loading…"
              onClick={() => void loadRetiredOnce()}
              className="mt-3 self-start text-xs text-[var(--color-muted)] underline"
            >
              Show retired instructions
            </ActionButton>
          ) : retired.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5" data-component="RetiredDirectives">
              {retired.map((directive) => (
                <li
                  key={directive.id}
                  className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-muted)] line-through"
                >
                  {directive.body}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Nothing retired yet.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Retire / Activate on one instruction — its own lock per row. */
function DirectiveAction({
  path,
  label,
  pendingLabel,
  className,
  onDone,
}: {
  path: string;
  label: string;
  pendingLabel: string;
  className: string;
  onDone: () => void;
}) {
  const action = useProjectAction();
  return (
    <span className="flex flex-col items-end">
      <ActionButton
        busy={action.busy}
        pendingLabel={pendingLabel}
        onClick={() => void action.run(path, { skipRefresh: true, onSuccess: onDone })}
        className={className}
      >
        {label}
      </ActionButton>
      <ActionError
        action={action}
        className="flex flex-wrap items-center gap-2 text-xs text-red-300"
      />
    </span>
  );
}

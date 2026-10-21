"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { Spinner } from "@/components/ui/Spinner";
import type { ProjectLinkKind, ProjectsResponse } from "@/types";

/** The kinds the sheet offers — the ones a person adds by hand (§13). */
const KIND_OPTIONS: { value: ProjectLinkKind; label: string }[] = [
  { value: "todo", label: "To-do" },
  { value: "arrival", label: "Arrival (inbox)" },
  { value: "file", label: "File" },
  { value: "goal", label: "Goal" },
  { value: "memory", label: "Memory" },
  { value: "conversation", label: "Conversation" },
  { value: "sample", label: "Sample (match this)" },
  { value: "reference", label: "Reference (read this)" },
  { value: "url", label: "URL" },
];

export interface AddToProjectPrefill {
  kind?: ProjectLinkKind;
  ref?: string;
  label?: string;
}

/** The to-do this sheet may promote (§10) — set when opened from /todos. */
export interface PromoteInfo {
  todoId: string;
  todoTitle: string;
}

/**
 * The "Add" sheet (§13): attach a pointer to a project. A link is never a
 * copy — the authority stays in the owning profile (§11 rule 5), so the form
 * only asks for a kind, a ref and (optionally) a label/profile.
 *
 * Two modes: opened from the detail page the project is fixed; opened from a
 * to-do or an arrival it fetches the active projects and lets the user pick.
 * With `promote`, the same sheet offers the §10 promotion — the to-do becomes
 * a card in `triage` and moves to `working` (human-only, one-way).
 *
 * Both writes go through `useProjectAction`: one request per click, pending
 * until the server answers, and a refused write keeps the sheet open with
 * the reason and Retry (same idempotency key).
 */
export function AddToProjectSheet({
  onClose,
  fixedSlug,
  fixedName,
  prefill,
  promote,
}: {
  onClose: () => void;
  /** Set when opened from `/projects/[slug]` — the picker is skipped. */
  fixedSlug?: string;
  fixedName?: string;
  prefill?: AddToProjectPrefill;
  promote?: PromoteInfo;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<
    { slug: string; name: string }[] | null
  >(fixedSlug ? [] : null);
  const [slug, setSlug] = useState(fixedSlug ?? "");
  const [kind, setKind] = useState<ProjectLinkKind>(prefill?.kind ?? "todo");
  const [ref, setRef] = useState(prefill?.ref ?? "");
  const [label, setLabel] = useState(prefill?.label ?? "");
  const [profile, setProfile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const linkAction = useProjectAction();
  const promoteAction = useProjectAction();
  const busy = linkAction.busy || promoteAction.busy;
  const writeError = linkAction.error ?? promoteAction.error;

  useEffect(() => {
    if (fixedSlug) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/projects?status=active&limit=50");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ProjectsResponse;
        if (cancelled) return;
        setProjects(data.items.map((p) => ({ slug: p.slug, name: p.name })));
        if (data.items.length > 0) setSlug(data.items[0].slug);
      } catch {
        if (!cancelled) {
          setError("Could not load the project list.");
          setProjects([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixedSlug]);

  const add = () => {
    const trimmedRef = ref.trim();
    if (!slug || !trimmedRef || busy) return;
    promoteAction.clearError();
    void linkAction.run(`/api/projects/${encodeURIComponent(slug)}/links`, {
      body: {
        kind,
        ref: trimmedRef,
        label: label.trim() || undefined,
        profile: profile.trim() || undefined,
      },
      // The caller refreshes on close; closing is the confirmed state.
      skipRefresh: true,
      onSuccess: () => onClose(),
    });
  };

  const promoteTodo = () => {
    if (!slug || !promote || busy) return;
    linkAction.clearError();
    void promoteAction.run(`/api/projects/${encodeURIComponent(slug)}/cards`, {
      // A promotion always reads the to-do from the profile serving this
      // request — the sheet knows no foreign profile, so it names none
      // (the backend refuses any other one; see E2).
      body: { from_todo: { id: promote.todoId } },
      skipRefresh: true,
      onSuccess: () => {
        onClose();
        router.push(`/projects/${encodeURIComponent(slug)}`);
      },
    });
  };

  const inputClass =
    "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm";

  return (
    <div
      data-component="AddToProjectSheet"
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={onClose}
    >
      <div
        className="mx-auto flex w-full max-w-md flex-col gap-3 rounded-t-2xl border-x border-t border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        style={{ paddingBottom: "calc(var(--safe-bottom) + 1rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Add to project{fixedName ? ` — ${fixedName}` : ""}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-sm text-[var(--color-muted)]"
          >
            Close
          </button>
        </div>

        {!fixedSlug ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Project
            {projects === null ? (
              <span className="flex items-center gap-2 py-2 text-sm">
                <Spinner /> Loading projects…
              </span>
            ) : projects.length === 0 ? (
              <span className="py-1 text-sm text-[var(--color-text)]">
                No active projects yet.
              </span>
            ) : (
              <select
                className={inputClass}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Kind
          <select
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as ProjectLinkKind)}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Reference (id or path)
          <input
            className={inputClass}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={
              kind === "url" ? "https://…" : "e.g. todo id, file path, session id"
            }
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Label (optional)
          <input
            className={inputClass}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What this is, in your words"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Profile (optional)
          <input
            className={inputClass}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder="Where it lives — defaults to the host profile"
          />
        </label>

        <p className="text-xs text-[var(--color-muted)]">
          Linking keeps a to-do a to-do — it only adds a pointer. Promoting
          turns it into a card on the project&rsquo;s board and moves the
          to-do to working.
        </p>

        {error ?? writeError ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-red-400" role="alert">
            {error ?? writeError}
            {writeError ? (
              <ActionButton
                busy={linkAction.busy || promoteAction.busy}
                pendingLabel="Retrying…"
                onClick={() =>
                  void (linkAction.error ? linkAction.retry() : promoteAction.retry())
                }
                className="text-xs underline"
              >
                Retry
              </ActionButton>
            ) : null}
          </p>
        ) : null}

        {promote ? (
          <ActionButton
            busy={promoteAction.busy}
            pendingLabel="Promoting…"
            onClick={promoteTodo}
            disabled={linkAction.busy || !slug}
            className="rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Promote to card
          </ActionButton>
        ) : null}

        <ActionButton
          busy={linkAction.busy}
          pendingLabel="Adding…"
          onClick={add}
          disabled={promoteAction.busy || !slug || !ref.trim()}
          className={
            promote
              ? "rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-sm font-medium disabled:opacity-50"
              : "rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          }
        >
          Add link
        </ActionButton>
      </div>
    </div>
  );
}

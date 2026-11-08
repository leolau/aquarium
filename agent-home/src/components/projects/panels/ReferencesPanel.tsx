"use client";

import { useMemo, useState } from "react";

import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { InputRow } from "@/components/projects/inputs/InputRow";
import {
  groupInputLinks,
  toProjectLink,
  upsertLink,
  withoutLink,
} from "@/components/projects/inputs/inputKinds";
import { LinkNoteInput } from "@/components/projects/inputs/LinkNoteInput";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useRefresh, useServerState } from "@/components/ui/useRefresh";
import type { ProjectDetail, ProjectLink } from "@/types";

const KIND_ICON: Partial<Record<ProjectLink["kind"], string>> = {
  url: "🔗",
  todo: "☑",
  arrival: "📥",
  conversation: "💬",
};

/**
 * Links and notes (§13): URLs, short notes, and pointers to to-dos, inbox
 * items and conversations. A note is a `reference` link whose ref carries
 * the text (`note:…`), so the run reads it like any other reference.
 */
export function ReferencesPanel({
  project,
  archived = false,
  callerUserId,
}: {
  project: ProjectDetail;
  archived?: boolean;
  callerUserId?: string;
}) {
  const fromServer = useMemo(() => groupInputLinks(project.links).links, [project.links]);
  const [links, setLinks] = useServerState<ProjectLink[]>(fromServer);
  const [sheetOpen, setSheetOpen] = useState(false);
  const action = useProjectAction<Partial<ProjectLink>>();
  const { refresh } = useRefresh();
  const profile = project.host_profile ?? "default";

  return (
    <section
      id="panel-references"
      data-component="ReferencesPanel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div>
        <h2 className="text-sm font-semibold">🔗 Links &amp; notes</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Web links, short notes, to-dos and conversations
        </p>
      </div>

      {links.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          No links or notes yet. Paste a link, or write down anything the
          agent should keep in mind.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {links.map((link) => (
            <InputRow
              key={`${link.kind}:${link.profile}:${link.ref}`}
              slug={project.slug}
              link={link}
              icon={KIND_ICON[link.kind] ?? (link.ref.startsWith("note:") ? "✎" : "🔗")}
              callerUserId={callerUserId}
              archived={archived}
              onRemoved={(gone) => setLinks((prev) => withoutLink(prev, gone))}
            />
          ))}
        </ul>
      )}

      {archived ? null : (
        <>
          <LinkNoteInput
            busy={action.busy}
            onAdd={async (entry) => {
              const result = await action.run(
                `/api/projects/${encodeURIComponent(project.slug)}/links`,
                {
                  body: entry,
                  onSuccess: (data) =>
                    setLinks((prev) =>
                      upsertLink(
                        prev,
                        toProjectLink(
                          { ...entry, ...data },
                          { projectId: project.id, profile, addedBy: callerUserId },
                        ),
                      ),
                    ),
                },
              );
              return Boolean(result?.ok);
            }}
          />
          {action.error ? (
            <p role="alert" className="flex items-center gap-2 text-xs text-[var(--color-danger)]">
              {action.error}
              <button type="button" onClick={() => void action.retry()} className="underline">
                Retry
              </button>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="self-start text-xs text-[var(--color-muted)] underline"
          >
            Link a to-do, inbox item or conversation
          </button>
        </>
      )}

      {sheetOpen ? (
        <AddToProjectSheet
          onClose={() => {
            setSheetOpen(false);
            refresh();
          }}
          fixedSlug={project.slug}
          fixedName={project.name}
          prefill={{ kind: "todo" }}
        />
      ) : null}
    </section>
  );
}

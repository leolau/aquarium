"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { useT } from "@/i18n";
import type { ProjectDetail, ProjectToolsResolution } from "@/types";

function splitCsv(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function ChipGroup({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-2">
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item}
            className="rounded-full bg-[var(--color-surface-2)] px-2.5 py-1 text-xs"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Tool narrowing (§4.1): CSV filters intersected with the host profile at
 * spawn. Empty means "the full host toolset", so the panel says that plainly
 * instead of collapsing. The edit form writes comma-separated lists; the
 * response shows what would *actually* run, including what the profile
 * refused (dropped_toolsets / dropped_skills).
 */
export function ToolsPanel({
  project,
  archived = false,
  onOpenSkills,
}: {
  project: ProjectDetail;
  archived?: boolean;
  /** Switch to the project's Skills tab (usage + AI improve/create). */
  onOpenSkills?: () => void;
}) {
  const t = useT("projects");
  const [toolsets, setToolsets] = useState(splitCsv(project.toolsets));
  const [skills, setSkills] = useState(splitCsv(project.skills));
  const [toolsetsDraft, setToolsetsDraft] = useState(
    splitCsv(project.toolsets).join(", "),
  );
  const [skillsDraft, setSkillsDraft] = useState(
    splitCsv(project.skills).join(", "),
  );
  const action = useProjectAction<ProjectToolsResolution>();
  const busy = action.busy;
  const [resolution, setResolution] = useState<ProjectToolsResolution | null>(
    null,
  );

  const slug = project.slug;

  const save = () =>
    action.run(`/api/projects/${encodeURIComponent(slug)}/tools`, {
      method: "PATCH",
      body: {
        toolsets: splitCsv(toolsetsDraft),
        skills: splitCsv(skillsDraft),
      },
      // The answer is what would actually run; show it straight away.
      onSuccess: (data) => {
        setToolsets(data.toolsets ?? []);
        setSkills(data.skills ?? []);
        setResolution(data);
      },
    });

  const inputClass =
    "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm";

  return (
    <section
      id="panel-tools"
      data-component="ToolsPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Tools
        </h2>
        <a
          href="?tab=skills"
          onClick={(e) => {
            if (!onOpenSkills) return;
            e.preventDefault();
            onOpenSkills();
          }}
          className="inline-flex min-h-11 items-center text-xs text-[var(--color-accent)] underline-offset-2 hover:underline md:min-h-0"
        >
          {t("skillsTab.manageInTab")}
        </a>
      </div>

      <ActionError action={action} />

      {toolsets.length === 0 && skills.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          No narrowing — runs inherit the full host profile toolset.
        </p>
      ) : (
        <>
          {toolsets.length > 0 ? (
            <ChipGroup label="Toolsets" items={toolsets} />
          ) : null}
          {skills.length > 0 ? <ChipGroup label="Skills" items={skills} /> : null}
        </>
      )}

      {resolution ? (
        <div className="mt-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-muted)]">
          <p>
            Effective toolsets:{" "}
            {resolution.effective_toolsets.length > 0
              ? resolution.effective_toolsets.join(", ")
              : "full host set"}
          </p>
          {resolution.dropped_toolsets.length > 0 ? (
            <p className="text-[var(--color-danger)]">
              Dropped (not on host): {resolution.dropped_toolsets.join(", ")}
            </p>
          ) : null}
          <p>
            Effective skills:{" "}
            {resolution.effective_skills.length > 0
              ? resolution.effective_skills.join(", ")
              : "none"}
          </p>
          {resolution.dropped_skills.length > 0 ? (
            <p className="text-[var(--color-danger)]">
              Dropped skills: {resolution.dropped_skills.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {project.host_profile ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Host profile: {project.host_profile} — narrowing is intersected with
          it at spawn (§4.1).
        </p>
      ) : null}

      {archived ? (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          This project is archived — restore it (⋯) to change tools.
        </p>
      ) : (
        <BusyRegion busy={busy} label="Saving…" className="mt-3">
          <div data-component="ToolsEditForm" className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
              Toolsets (comma-separated)
              <input
                className={inputClass}
                value={toolsetsDraft}
                onChange={(e) => setToolsetsDraft(e.target.value)}
                placeholder="e.g. web, file, terminal"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
              Skills (comma-separated)
              <input
                className={inputClass}
                value={skillsDraft}
                onChange={(e) => setSkillsDraft(e.target.value)}
                placeholder="e.g. digest-writer, canva"
              />
            </label>
            <ActionButton
              busy={busy}
              pendingLabel="Saving…"
              onClick={() => void save()}
              className="self-start rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] disabled:opacity-40"
            >
              Save
            </ActionButton>
          </div>
        </BusyRegion>
      )}
    </section>
  );
}

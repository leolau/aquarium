"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  filterLibrary,
  kindCount,
  LIBRARY_KINDS,
  libraryRows,
  librarySourceLabel,
  type LibraryFilter,
  type LibraryRow,
} from "@/components/skills/library";
import { NewSkillModal } from "@/components/skills/NewSkillModal";
import { SkillsHubView } from "@/components/skills/SkillsHubView";
import { SkillUsageSignal } from "@/components/skills/SkillUsagePanel";
import { skillHref } from "@/components/skills/skill-links";
import { Pill } from "@/components/ui/Pill";
import { inputClass, primaryButtonClass } from "@/components/ui/Sheet";
import { errorText, getJson } from "@/lib/admin-fetch";
import { ALL_SKILL_PERMISSIONS, type SkillPermissions } from "@/lib/skills/permissions";
import type { SkillUsageList, SkillUsageRow } from "@/lib/skills/usage";
import type { SkillLibrary, TriageStatus } from "@/types";

export interface SkillsViewProps {
  profiles: string[];
  /** The profile new skills and hub installs go into by default. */
  profile: string;
  initialLibrary: SkillLibrary;
  /** The caller's triage setup (`GET /api/triage/status`); null when unknown. */
  triage?: TriageStatus | null;
  initialView: "installed" | "hub";
  error: string | null;
  /** What the caller may do (Settings → Skills permissions): `manage` adds the
   *  edit controls and the hub, `lab` the usage signals. */
  permissions?: SkillPermissions;
  /** Owner/admin: may change which profiles use a skill (Agent Profiles). */
  canAdminister?: boolean;
}

/** Where a row's skill page lives: its first profile with a copy. */
function rowProfile(r: LibraryRow, fallback: string): string {
  return r.owners[0] ?? r.used_by[0]?.profile ?? fallback;
}

function UsedBy({ row }: { row: LibraryRow }) {
  if (row.triage) {
    return (
      <span className={`text-xs ${row.triage.on ? "text-[var(--color-success)]" : "text-[var(--color-muted)]"}`}>
        {row.triage.kind} triage · {row.triage.on ? "on for you" : "not set up"}
      </span>
    );
  }
  if (!row.used_by.length) return <span className="text-xs text-[var(--color-muted)]">—</span>;
  return (
    <>
      {row.used_by.map((u) => (
        <span
          key={u.profile}
          data-used-by={u.profile}
          data-state={u.enabled ? "on" : "off"}
          title={`${u.profile}: ${u.enabled ? "on" : "removed (file kept)"}`}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
            u.enabled
              ? "bg-[var(--color-accent)]/15 text-[var(--color-fg)]"
              : "bg-[var(--color-surface-2)] text-[var(--color-muted)] line-through decoration-[var(--color-muted)]/60"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${u.enabled ? "bg-[var(--color-success)]" : "bg-[var(--color-muted)]"}`} />
          {u.profile}
        </span>
      ))}
    </>
  );
}

/** The Skills page body: the box-wide skills library, or the Skills hub. */
export function SkillsView({
  profiles,
  profile,
  initialLibrary,
  triage = null,
  initialView,
  error,
  permissions = ALL_SKILL_PERMISSIONS,
  canAdminister = false,
}: SkillsViewProps) {
  const { manage, lab } = permissions;
  const [library, setLibrary] = useState(initialLibrary);
  const [view, setView] = useState(manage ? initialView : "installed");
  const [filter, setFilter] = useState<LibraryFilter>({ kind: "all", category: "", profile: "", search: "" });
  const [hubProfile, setHubProfile] = useState(profile);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(error);

  const reload = useCallback(async () => {
    try {
      setLibrary(await getJson<SkillLibrary>("/api/skills/library"));
      setMessage(null);
    } catch (err) {
      setMessage(errorText(err));
    }
  }, []);

  // Uses and results per skill, once per list load; the list works without them.
  const [usage, setUsage] = useState<{ days: number; byName: Map<string, SkillUsageRow> } | null>(null);
  useEffect(() => {
    if (!lab) return;
    let live = true;
    getJson<SkillUsageList>("/api/skills/usage?days=90")
      .then((d) => live && setUsage({ days: d.days, byName: new Map(d.skills.map((r) => [r.name, r])) }))
      .catch(() => live && setUsage(null));
    return () => {
      live = false;
    };
  }, [lab]);

  const rows = useMemo(() => libraryRows(library, triage), [library, triage]);
  const visible = useMemo(() => filterLibrary(rows, filter), [rows, filter]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.category || "uncategorised", (counts.get(r.category || "uncategorised") ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);
  const profileList = library.profiles.length ? library.profiles : profiles;
  const set = (patch: Partial<LibraryFilter>) => setFilter((f) => ({ ...f, ...patch }));

  const sideItem = (key: string, label: string, count: number) => {
    const active = filter.category === key;
    return (
      <li key={key || "all"}>
        <button
          type="button"
          aria-pressed={active}
          onClick={() => set({ category: key })}
          className={`flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-sm ${
            active ? "bg-[var(--color-surface-2)] font-medium" : "text-[var(--color-muted)]"
          }`}
        >
          <span className="flex-1 truncate">{label}</span>
          <span className="text-xs">{count}</span>
        </button>
      </li>
    );
  };

  return (
    <section data-component="SkillsView" className="space-y-4 pb-24 lg:pb-8">
      <div className="flex flex-wrap items-center gap-3">
        {manage ? (
        <div role="tablist" aria-label="Skills view" className="inline-flex rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1">
          <button type="button" role="tab" data-action="view-installed" aria-selected={view === "installed"} onClick={() => setView("installed")} className={"min-h-9 rounded-[var(--radius-md)] px-3.5 text-sm font-medium aria-selected:bg-[var(--color-bg)] aria-selected:text-[var(--color-fg)] text-[var(--color-muted)]"}>
            Library
          </button>
          <button type="button" role="tab" data-action="view-hub" aria-selected={view === "hub"} onClick={() => setView("hub")} className={"min-h-9 rounded-[var(--radius-md)] px-3.5 text-sm font-medium aria-selected:bg-[var(--color-bg)] aria-selected:text-[var(--color-fg)] text-[var(--color-muted)]"}>
            Hub
          </button>
        </div>
        ) : null}
        <span className="flex-1" />
        {view === "hub" ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--color-muted)]">Install into</span>
            <select aria-label="Install into" className={`${inputClass} w-auto`} value={hubProfile} onChange={(e) => setHubProfile(e.target.value)}>
              {profileList.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <span className="text-[var(--color-muted)]">Used by</span>
            <select aria-label="Used by" className={`${inputClass} w-auto`} value={filter.profile} onChange={(e) => set({ profile: e.target.value })}>
              <option value="">Any profile</option>
              {profileList.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        {view === "installed" && manage ? (
          <button type="button" data-action="new-skill" className={primaryButtonClass} onClick={() => setCreating(true)}>
            + New skill
          </button>
        ) : null}
      </div>

      {message ? (
        <p role="alert" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-danger)]">
          {message}
        </p>
      ) : null}

      {view === "hub" ? (
        <SkillsHubView key={hubProfile} profile={hubProfile} onInstalled={reload} />
      ) : (
        <>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <input
              aria-label="Search skills"
              className={`${inputClass} md:max-w-xs`}
              placeholder="Search skills…"
              value={filter.search}
              onChange={(e) => set({ search: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-2">
              {LIBRARY_KINDS.map(({ kind, label }) => {
                const active = filter.kind === kind;
                const special = kind === "triage";
                return (
                  <button
                    key={kind}
                    type="button"
                    data-filter={kind}
                    aria-pressed={active}
                    onClick={() => set({ kind })}
                    className={`inline-flex min-h-9 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-xs ${
                      active
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                        : special
                          ? "border-[var(--color-warn)]/70 bg-[var(--color-attention-bg)] font-medium text-[var(--color-warn-text)]"
                          : "border-[var(--color-border)] text-[var(--color-fg)]"
                    }`}
                  >
                    {special ? "◆ " : ""}
                    {label} <span className="opacity-80">{kindCount(rows, kind)}</span>
                  </button>
                );
              })}
              <select
                aria-label="Category"
                className={`${inputClass} w-auto min-h-9 py-1 text-xs lg:hidden`}
                value={filter.category}
                onChange={(e) => set({ category: e.target.value })}
              >
                <option value="">All categories</option>
                {categories.map(([c, n]) => (
                  <option key={c} value={c}>
                    {c} ({n})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <nav aria-label="Skill filters" className="hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 lg:block lg:w-60 lg:shrink-0">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Categories</p>
              <ul className="flex flex-col gap-0.5">
                {sideItem("", "All categories", rows.length)}
                {categories.map(([c, n]) => sideItem(c, c === "triage" ? "◆ triage" : c, n))}
              </ul>
            </nav>

            <div className="min-w-0 flex-1 space-y-3">
              <div className="hidden grid-cols-[minmax(0,1fr)_14rem_auto] gap-2 px-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)] lg:grid">
                <span>Skill</span>
                <span>Used by</span>
                <span className="w-12" />
              </div>
              <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                {visible.map((r) => {
                  const home = rowProfile(r, profile);
                  return (
                  <li
                    key={`${r.kind}:${r.name}`}
                    data-component="SkillRow"
                    data-skill={r.name}
                    data-kind={r.kind}
                    className={`grid grid-cols-1 items-center gap-2 p-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_14rem_auto] ${r.triage ? "bg-[var(--color-attention-bg)]" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.triage ? (
                          <span className="font-medium [overflow-wrap:anywhere]">{r.name}</span>
                        ) : (
                          <Link href={skillHref(r.name, home)} className="font-medium [overflow-wrap:anywhere] hover:text-[var(--color-accent)]">
                            {r.name}
                          </Link>
                        )}
                        {r.category && !r.triage ? <Pill>{r.category}</Pill> : null}
                        {r.triage ? (
                          <Pill tone="warning">◆ triage</Pill>
                        ) : (
                          <Pill tone={r.kind === "hub" ? "accent" : "muted"}>
                            {librarySourceLabel({ source: r.kind as Exclude<typeof r.kind, "triage">, trust_level: r.trust_level, owners: r.owners })}
                          </Pill>
                        )}
                        {usage && !r.triage ? <SkillUsageSignal row={usage.byName.get(r.name)} days={usage.days} /> : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">{r.description}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs text-[var(--color-muted)] lg:hidden">Used by</span>
                      <UsedBy row={r} />
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      {manage && !r.triage && r.used_by.length ? (
                        <Link
                          href={skillHref(r.name, home, "edit")}
                          role="button"
                          aria-label={`Edit ${r.name}`}
                          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                        >
                          Edit
                        </Link>
                      ) : null}
                    </div>
                  </li>
                  );
                })}
                {visible.length === 0 ? (
                  <li className="p-6 text-center text-sm text-[var(--color-muted)]">
                    {rows.length === 0
                      ? manage
                        ? "No skills installed yet. Add one, or browse the hub."
                        : "No skills installed yet."
                      : "No skills match. Try another search or filter."}
                  </li>
                ) : null}
              </ul>
              <p data-testid="skills-library-hint" className="text-xs text-[var(--color-muted)]">
                {canAdminister
                  ? "Turn a skill on or off per profile from a profile's Skills panel. Changes apply to new chats."
                  : "You can see the library. Only an owner or admin can add, remove or edit skills."}
              </p>
            </div>
          </div>
        </>
      )}

      {creating && manage ? (
        <NewSkillModal
          profile={filter.profile || profile}
          categories={categories.map(([c]) => c).filter((c) => c !== "triage" && c !== "uncategorised")}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await reload();
          }}
        />
      ) : null}
    </section>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NewSkillModal } from "@/components/skills/NewSkillModal";
import { SkillsHubView } from "@/components/skills/SkillsHubView";
import { SkillUsageSignal } from "@/components/skills/SkillUsagePanel";
import { skillHref } from "@/components/skills/skill-links";
import { categoryCounts, filterSkills, sourceLabel, type SkillFilter } from "@/components/skills/skill-filters";
import { InfoTip } from "@/components/ui/InfoTip";
import { Pill } from "@/components/ui/Pill";
import { useUndoToast } from "@/components/ui/UndoToast";
import { inputClass, primaryButtonClass } from "@/components/ui/Sheet";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import { useAction } from "@/lib/use-action";
import type { SkillUsageList, SkillUsageRow } from "@/lib/skills/usage";
import type { SkillInfo } from "@/types";

export interface SkillsViewProps {
  profiles: string[];
  profile: string;
  initialSkills: SkillInfo[];
  initialView: "installed" | "hub";
  error: string | null;
}

/** The Skills page body: installed skills for one profile, or the Skills hub. */
export function SkillsView({ profiles, profile, initialSkills, initialView, error }: SkillsViewProps) {
  const router = useRouter();
  const [skills, setSkills] = useState(initialSkills);
  const [view, setView] = useState(initialView);
  const [filter, setFilter] = useState<SkillFilter>({ kind: "all" });
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(error);

  const q = profileQuery(profile);
  const reload = useCallback(async () => {
    try {
      setSkills(await getJson<SkillInfo[]>(`/api/skills${q ? `?${q}` : ""}`));
      setMessage(null);
    } catch (err) {
      setMessage(errorText(err));
    }
  }, [q]);

  // Uses and results per skill, once per list load; the list works without them.
  const [usage, setUsage] = useState<{ days: number; byName: Map<string, SkillUsageRow> } | null>(null);
  useEffect(() => {
    let live = true;
    getJson<SkillUsageList>(`/api/skills/usage?days=90${q ? `&${q}` : ""}`)
      .then((d) => live && setUsage({ days: d.days, byName: new Map(d.skills.map((r) => [r.name, r])) }))
      .catch(() => live && setUsage(null));
    return () => {
      live = false;
    };
  }, [q]);

  const undo = useUndoToast();
  const setEnabled = useCallback(
    async (name: string, enabled: boolean): Promise<boolean> => {
      setMessage(null);
      try {
        await sendJson("/api/skills/toggle", "PUT", { name, enabled, ...(q ? { profile } : {}) });
        setSkills((list) => list.map((s) => (s.name === name ? { ...s, enabled } : s)));
        return true;
      } catch (err) {
        setMessage(errorText(err));
        return false;
      }
    },
    [q, profile],
  );
  const toggle = useAction(async (skill: SkillInfo) => {
    const next = !skill.enabled;
    if (await setEnabled(skill.name, next)) {
      undo.show(
        `${skill.name} turned ${next ? "on" : "off"} for new chats`,
        () => setEnabled(skill.name, !next),
      );
    }
  });

  function selectProfile(next: string) {
    const nq = profileQuery(next);
    const params = [nq, view === "hub" ? "view=hub" : ""].filter(Boolean).join("&");
    router.push(`/skills${params ? `?${params}` : ""}`);
  }

  const categories = useMemo(() => categoryCounts(skills), [skills]);
  const visible = useMemo(() => filterSkills(skills, filter, search), [skills, filter, search]);
  const enabledCount = skills.filter((s) => s.enabled).length;
  const categoryList = categories.map(([c]) => c);

  const sideItem = (key: string, label: string, count: number, f: SkillFilter) => {
    const active =
      filter.kind === f.kind && (f.kind !== "category" || (filter.kind === "category" && filter.category === f.category));
    return (
      <li key={key}>
        <button
          type="button"
          aria-pressed={active}
          onClick={() => setFilter(f)}
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

  const chip = (key: string, label: string, count: number, f: SkillFilter) => {
    const active = filter.kind === f.kind;
    return (
      <button
        key={key}
        type="button"
        aria-pressed={active}
        onClick={() => setFilter(f)}
        className={`inline-flex min-h-9 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-xs ${
          active
            ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
            : "border-[var(--color-border)] text-[var(--color-fg)]"
        }`}
      >
        {label} <span className="opacity-80">{count}</span>
      </button>
    );
  };
  const activeCategory = filter.kind === "category" ? filter.category : "";

  return (
    <section data-component="SkillsView" className="space-y-4 pb-24 lg:pb-8">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Skills view" className="inline-flex rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1">
          <button type="button" role="tab" data-action="view-installed" aria-selected={view === "installed"} onClick={() => setView("installed")} className={"min-h-9 rounded-[var(--radius-md)] px-3.5 text-sm font-medium aria-selected:bg-[var(--color-bg)] aria-selected:text-[var(--color-fg)] text-[var(--color-muted)]"}>
            Installed
          </button>
          <button type="button" role="tab" data-action="view-hub" aria-selected={view === "hub"} onClick={() => setView("hub")} className={"min-h-9 rounded-[var(--radius-md)] px-3.5 text-sm font-medium aria-selected:bg-[var(--color-bg)] aria-selected:text-[var(--color-fg)] text-[var(--color-muted)]"}>
            Hub
          </button>
        </div>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-muted)]">{view === "hub" ? "Install into" : "Profile"}</span>
          <select
            aria-label="Profile"
            className={`${inputClass} w-auto`}
            value={profile}
            onChange={(e) => selectProfile(e.target.value)}
          >
            {(profiles.length ? profiles : [profile]).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        {view === "installed" ? (
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
        <SkillsHubView profile={profile} onInstalled={reload} />
      ) : (
        <>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <input
              aria-label="Search skills"
              className={`${inputClass} md:max-w-xs`}
              placeholder="Search skills…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              {chip("all", "All", skills.length, { kind: "all" })}
              {chip("enabled", "Enabled", enabledCount, { kind: "enabled" })}
              {chip("disabled", "Disabled", skills.length - enabledCount, { kind: "disabled" })}
              <select
                aria-label="Category"
                className={`${inputClass} w-auto min-h-9 py-1 text-xs lg:hidden`}
                value={activeCategory}
                onChange={(e) => setFilter(e.target.value ? { kind: "category", category: e.target.value } : { kind: "all" })}
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
                {sideItem("all", "All categories", skills.length, { kind: "all" })}
                {categories.map(([c, n]) => sideItem(`cat-${c}`, c, n, { kind: "category", category: c }))}
              </ul>
            </nav>

            <div className="min-w-0 flex-1 space-y-3">
              <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                {visible.map((s) => (
                  <li key={s.name} data-component="SkillRow" data-skill={s.name} className="flex items-center gap-2 p-3 sm:gap-3 sm:px-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link href={skillHref(s.name, profile)} className="font-medium [overflow-wrap:anywhere] hover:text-[var(--color-accent)]">
                          {s.name}
                        </Link>
                        {s.category ? <Pill>{s.category}</Pill> : null}
                        <Pill tone={s.source === "hub" ? "accent" : "muted"}>{sourceLabel(s)}</Pill>
                        {usage ? <SkillUsageSignal row={usage.byName.get(s.name)} days={usage.days} /> : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">{s.description}</p>
                    </div>
                    <Link
                      href={skillHref(s.name, profile, "edit")}
                      role="button"
                      aria-label={`Edit ${s.name}`}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                    >
                      Edit
                    </Link>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={s.enabled}
                      aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                      disabled={toggle.pending}
                      aria-busy={toggle.pending || undefined}
                      onClick={() => void toggle.run(s)}
                      className="flex h-11 w-14 shrink-0 items-center justify-center disabled:opacity-60"
                    >
                      <span
                        className={`relative block h-6 w-11 rounded-full transition-colors ${
                          s.enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)]"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-fg)] transition-all ${
                            s.enabled ? "left-[1.375rem]" : "left-0.5"
                          }`}
                        />
                      </span>
                    </button>
                  </li>
                ))}
                {visible.length === 0 ? (
                  <li className="p-6 text-center text-sm text-[var(--color-muted)]">
                    {skills.length === 0 ? "No skills installed yet. Add one, or browse the hub." : "No skills match. Try another search or filter."}
                  </li>
                ) : null}
              </ul>
              <p className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                Turning a skill off or editing it applies to new chats.
                <InfoTip label="Why not running chats?">
                  Running chats keep their skills so their cache isn&apos;t broken (which would make every reply cost more).
                </InfoTip>
              </p>
            </div>
          </div>
        </>
      )}
      {undo.toast}

      {creating ? (
        <NewSkillModal
          profile={profile}
          categories={categoryList}
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

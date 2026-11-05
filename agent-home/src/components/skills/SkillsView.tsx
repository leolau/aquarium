"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { NewSkillModal } from "@/components/skills/NewSkillModal";
import { SkillsHubView } from "@/components/skills/SkillsHubView";
import { skillHref } from "@/components/skills/skill-links";
import { categoryCounts, filterSkills, sourceLabel, type SkillFilter } from "@/components/skills/skill-filters";
import { Pill } from "@/components/ui/Pill";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import { useAction } from "@/lib/use-action";
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

  const toggle = useAction(async (skill: SkillInfo) => {
    setMessage(null);
    try {
      await sendJson("/api/skills/toggle", "PUT", {
        name: skill.name,
        enabled: !skill.enabled,
        ...(q ? { profile } : {}),
      });
      setSkills((list) => list.map((s) => (s.name === skill.name ? { ...s, enabled: !s.enabled } : s)));
    } catch (err) {
      setMessage(errorText(err));
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

  return (
    <section data-component="SkillsView" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-muted)]">{view === "hub" ? "Install into:" : "Profile:"}</span>
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
        <span className="flex-1" />
        {view === "hub" ? (
          <button type="button" className={secondaryButtonClass} onClick={() => setView("installed")}>
            ← Installed skills
          </button>
        ) : (
          <>
            <button type="button" className={secondaryButtonClass} onClick={() => setView("hub")}>
              Browse hub
            </button>
            <button type="button" className={primaryButtonClass} onClick={() => setCreating(true)}>
              + New skill
            </button>
          </>
        )}
      </div>

      {message ? (
        <p role="alert" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-red-300">
          {message}
        </p>
      ) : null}

      {view === "hub" ? (
        <SkillsHubView profile={profile} onInstalled={reload} />
      ) : (
        <div className="flex flex-col gap-4 md:flex-row">
          <nav aria-label="Skill filters" className="md:w-56 md:shrink-0">
            <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {sideItem("all", "All", skills.length, { kind: "all" })}
              {sideItem("enabled", "Enabled", enabledCount, { kind: "enabled" })}
              {sideItem("disabled", "Disabled", skills.length - enabledCount, { kind: "disabled" })}
              <li className="hidden px-3 pt-3 text-xs uppercase tracking-wide text-[var(--color-muted)] md:block">
                Categories
              </li>
              {categories.map(([c, n]) => sideItem(`cat-${c}`, c, n, { kind: "category", category: c }))}
            </ul>
          </nav>

          <div className="min-w-0 flex-1 space-y-3">
            <input
              aria-label="Search skills"
              className={inputClass}
              placeholder="Search skills…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <ul className="divide-y divide-[var(--color-border)] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
              {visible.map((s) => (
                <li key={s.name} data-component="SkillRow" data-skill={s.name} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link href={skillHref(s.name, profile)} className="font-medium hover:text-[var(--color-accent)]">
                        {s.name}
                      </Link>
                      {s.category ? <Pill>{s.category}</Pill> : null}
                      <Pill tone={s.source === "hub" ? "accent" : "muted"}>{sourceLabel(s)}</Pill>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">{s.description}</p>
                  </div>
                  <Link href={skillHref(s.name, profile, "edit")} role="button" className={`${secondaryButtonClass} inline-flex items-center`}>
                    Edit
                  </Link>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={s.enabled}
                    aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                    disabled={toggle.pending}
                    onClick={() => void toggle.run(s)}
                    className="flex h-11 w-14 shrink-0 items-center justify-center disabled:opacity-60"
                  >
                    <span
                      className={`relative block h-6 w-11 rounded-full transition-colors ${
                        s.enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)]"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                          s.enabled ? "left-[1.375rem]" : "left-0.5"
                        }`}
                      />
                    </span>
                  </button>
                </li>
              ))}
              {visible.length === 0 ? (
                <li className="p-4 text-sm text-[var(--color-muted)]">No skills match.</li>
              ) : null}
            </ul>
            <p className="text-xs text-[var(--color-muted)]">
              Turning a skill off or editing it applies to new chats; running chats keep their skills
              so their cache isn&apos;t broken.
            </p>
          </div>
        </div>
      )}

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

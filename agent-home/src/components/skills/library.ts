import type { SkillLibrary, SkillLibraryEntry, SkillLibrarySource, TriageStatus } from "@/types";

/** The Skills page source chips; `triage` rows come from the triage pipelines. */
export type LibraryKind = SkillLibrarySource | "triage";

/** A row of the Skills library: a library skill, or a triage pipeline's skill. */
export interface LibraryRow {
  name: string;
  description: string;
  category: string;
  kind: LibraryKind;
  trust_level?: string;
  owners: string[];
  used_by: Array<{ profile: string; enabled: boolean }>;
  /** Triage rows: which pipeline reads it and whether it is on for the caller. */
  triage?: { kind: string; label: string; on: boolean };
}

export const LIBRARY_KINDS: Array<{ kind: LibraryKind | "all"; label: string }> = [
  { kind: "all", label: "All" },
  { kind: "builtin", label: "Built-in" },
  { kind: "hub", label: "Hub" },
  { kind: "shared", label: "Shared library" },
  { kind: "profile", label: "Profile-only" },
  { kind: "triage", label: "Triage" },
];

export function libraryRows(library: SkillLibrary, triage: TriageStatus | null = null): LibraryRow[] {
  const rows: LibraryRow[] = library.skills.map((s) => ({
    name: s.name,
    description: s.description,
    category: s.category,
    kind: s.source,
    trust_level: s.trust_level,
    owners: s.owners,
    used_by: s.used_by,
  }));
  const seen = new Set<string>();
  for (const k of triage?.kinds ?? []) {
    for (const folder of k.skills) {
      if (folder.layer !== "base" || seen.has(folder.name)) continue;
      seen.add(folder.name);
      rows.push({
        name: folder.name,
        description: `Read by the ${k.label.toLowerCase()} pipeline.`,
        category: "triage",
        kind: "triage",
        owners: [],
        used_by: [],
        triage: { kind: k.kind, label: k.label, on: k.status === "set_up" },
      });
    }
  }
  return rows;
}

export interface LibraryFilter {
  kind: LibraryKind | "all";
  category: string;
  profile: string;
  search: string;
}

export function filterLibrary(rows: LibraryRow[], f: LibraryFilter): LibraryRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind !== "all" && r.kind !== f.kind) return false;
    if (f.category && (r.category || "uncategorised") !== f.category) return false;
    if (f.profile && !r.used_by.some((u) => u.profile === f.profile)) return false;
    return !q || `${r.name} ${r.description} ${r.category}`.toLowerCase().includes(q);
  });
}

export function kindCount(rows: LibraryRow[], kind: LibraryKind | "all"): number {
  return kind === "all" ? rows.length : rows.filter((r) => r.kind === kind).length;
}

/** The source pill text: "built-in", "hub · trusted", "shared", "hr only". */
export function librarySourceLabel(skill: Pick<SkillLibraryEntry, "source" | "trust_level" | "owners">): string {
  if (skill.source === "hub") return `hub · ${skill.trust_level || "community"}`;
  if (skill.source === "builtin") return "built-in";
  if (skill.source === "shared") return "shared";
  return skill.owners.length === 1 ? `${skill.owners[0]} only` : "profile-only";
}

/** One profile's skills: on, and removed (turned off, file kept). */
export function profileSkills(library: SkillLibrary, profile: string): { on: SkillLibraryEntry[]; off: SkillLibraryEntry[] } {
  const on: SkillLibraryEntry[] = [];
  const off: SkillLibraryEntry[] = [];
  for (const s of library.skills) {
    const use = s.used_by.find((u) => u.profile === profile);
    if (!use) continue;
    (use.enabled ? on : off).push(s);
  }
  return { on, off };
}

/** The Add picker: library skills the profile doesn't have on (never triage skills). */
export function addCandidates(library: SkillLibrary, profile: string): SkillLibraryEntry[] {
  return library.skills.filter((s) => !s.used_by.some((u) => u.profile === profile && u.enabled));
}

/** A profile-only skill this profile has no copy of: ask shared vs only-here. */
export function needsCopyChoice(skill: SkillLibraryEntry, profile: string): boolean {
  return skill.source === "profile" && !skill.used_by.some((u) => u.profile === profile);
}

/** Delete is only for a profile's own skill (built-in, hub, shared: Remove only). */
export function canDelete(skill: SkillLibraryEntry, profile: string): boolean {
  return skill.source === "profile" && skill.owners.includes(profile);
}

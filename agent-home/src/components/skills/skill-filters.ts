import type { SkillInfo } from "@/types";

export type SkillFilter = { kind: "all" | "enabled" | "disabled" } | { kind: "category"; category: string };

export function categoryCounts(skills: SkillInfo[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const s of skills) {
    const c = s.category || "uncategorised";
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function filterSkills(skills: SkillInfo[], filter: SkillFilter, search: string): SkillInfo[] {
  const q = search.trim().toLowerCase();
  return skills.filter((s) => {
    if (filter.kind === "enabled" && !s.enabled) return false;
    if (filter.kind === "disabled" && s.enabled) return false;
    if (filter.kind === "category" && (s.category || "uncategorised") !== filter.category) return false;
    return !q || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q);
  });
}

/** The source chip text: "hub · trusted", "builtin", or "created here". */
export function sourceLabel(skill: SkillInfo): string {
  if (skill.source === "hub") return `hub · ${skill.trust_level || "community"}`;
  if (skill.source === "builtin") return "builtin";
  return "created here";
}

/** A SKILL.md skeleton for the New skill editor. */
export function skillTemplate(name: string, description: string, sources: string): string {
  const lines = [
    "---",
    `name: ${name || "my-skill"}`,
    `description: ${description.replace(/\s+/g, " ").trim() || "What this skill does"}`,
    "---",
    "",
    "1. …",
  ];
  const refs = sources
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (refs.length) lines.push("", "## Sources", "", ...refs.map((r) => `- ${r}`));
  return `${lines.join("\n")}\n`;
}

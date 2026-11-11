import type {
  ProjectSkillCandidate,
  ProjectSkillsProfile,
  ProjectSkillsResponse,
  ProjectSkillUsageRow,
} from "@/types";

export const SKILL_WINDOWS = [30, 90] as const;
export type SkillWindow = (typeof SKILL_WINDOWS)[number];

export interface ProjectSkill {
  name: string;
  profile: string;
  category: string | null;
  source: string | null;
  version: string | null;
  uses: number;
  success: number;
  partial: number;
  failed: number;
  ratedDown: number;
  lastUsedAt: number | null;
  preloaded: boolean;
  createdHere: boolean;
  trend: Array<{ day: string; uses: number }>;
}

export interface ProjectSkillsCandidate {
  id: string;
  name: string;
  runNo: number | null;
  preview: string;
}

export interface ProjectSkillsView {
  days: number;
  totals: { skills: number; uses: number; firstTimeRate: number | null; worthImproving: number };
  profiles: ProjectSkillsProfile[];
  skills: ProjectSkill[];
  unusedPreloaded: string[];
  candidates: ProjectSkillsCandidate[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function skillOf(row: ProjectSkillUsageRow): ProjectSkill {
  const o = row.outcomes;
  return {
    name: row.name,
    profile: row.profile || "default",
    category: row.category ?? null,
    source: row.source ?? null,
    version: row.version ?? null,
    uses: num(row.uses),
    success: num(o?.success ?? row.success),
    partial: num(o?.partial ?? row.partial),
    failed: num(o?.failed ?? o?.failure ?? row.failure),
    ratedDown: num(row.rated_down),
    lastUsedAt: typeof row.last_used_at === "number" ? row.last_used_at : null,
    preloaded: Boolean(row.preloaded),
    createdHere: Boolean(row.created_here),
    trend: Array.isArray(row.trend) ? row.trend : [],
  };
}

function candidateOf(c: ProjectSkillCandidate): ProjectSkillsCandidate {
  const run = c.run ?? c.run_no;
  return { id: String(c.id), name: c.name, runNo: typeof run === "number" ? run : null, preview: c.preview ?? "" };
}

/** Failed here, or rated "not helpful" here. */
export function worthImproving(skill: ProjectSkill): boolean {
  return skill.failed > 0 || skill.ratedDown > 0;
}

/**
 * Accepts both drafts of the B1 contract (Part B: `window_days`, `totals`,
 * `outcomes.failed`, `unused_preloaded`, `run`; Appendix B §3.2: `days`,
 * flat counts, `failure`, `preloaded_unused`, `run_no`) and fills `totals`
 * when the server leaves it out.
 */
export function normalizeProjectSkills(raw: ProjectSkillsResponse, fallbackDays: number): ProjectSkillsView {
  const skills = (raw.skills ?? []).map(skillOf).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  const used = skills.filter((s) => s.uses > 0);
  const rated = used.reduce((n, s) => n + s.success + s.partial + s.failed, 0);
  const success = used.reduce((n, s) => n + s.success, 0);
  const totals = raw.totals
    ? {
        skills: num(raw.totals.skills),
        uses: num(raw.totals.uses),
        firstTimeRate: typeof raw.totals.first_time_success_rate === "number" ? raw.totals.first_time_success_rate : null,
        worthImproving: num(raw.totals.worth_improving),
      }
    : {
        skills: used.length,
        uses: used.reduce((n, s) => n + s.uses, 0),
        firstTimeRate: rated ? success / rated : null,
        worthImproving: used.filter(worthImproving).length,
      };
  return {
    days: num(raw.window_days ?? raw.days) || fallbackDays,
    totals,
    profiles: raw.profiles ?? [],
    skills,
    unusedPreloaded: raw.unused_preloaded ?? raw.preloaded_unused ?? [],
    candidates: (raw.candidates ?? []).map(candidateOf),
  };
}

/** Skills `lab` in that profile: run-level evidence, Improve and New skill. */
export function canLabIn(view: ProjectSkillsView, profile: string): boolean {
  return view.profiles.some((p) => p.profile === profile && p.can_lab && !p.hidden);
}

export function percentLabel(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

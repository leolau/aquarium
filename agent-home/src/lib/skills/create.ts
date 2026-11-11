/** "New skill with AI" (Projects › Skills): request/response shapes and draft helpers. */
import type { SkillVersionMeta } from "@/lib/skills/improve";

export interface CreateSkillStart {
  profile?: string;
  project?: string;
  goal?: string;
  candidate_id?: string;
  card_ids?: string[];
}

export interface CreateSkillSave {
  profile?: string;
  name: string;
  content: string;
  category?: string;
  project?: string;
  session_id?: string;
  candidate_id?: string;
}

/** `POST /api/skills/create/save`: the skill exists, disabled, with draft v1 and no active version. */
export interface CreatedSkill {
  name: string;
  category?: string | null;
  enabled: false;
  version: SkillVersionMeta;
  profile?: string | null;
  project?: string;
  created_here?: boolean;
  candidate_id?: string;
}

/** A retro skill suggestion the Skills tab can turn into a skill. */
export interface SkillCandidateRef {
  id: string;
  name: string;
  body?: string;
}

/** Start of the hidden first-turn seed (`SEED_START` in `hermes_cli/skills_create_api.py`). */
export const CREATE_SEED_START = "You are helping me write a new skill";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `name:` from a SKILL.md frontmatter, when it is a valid skill name. */
export function draftSkillName(content: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  const line = fm?.[1].split("\n").find((l) => /^name\s*:/.test(l));
  const name = line?.replace(/^name\s*:\s*/, "").replace(/^["']|["']$/g, "").trim() ?? "";
  return NAME_RE.test(name) ? name : null;
}

export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

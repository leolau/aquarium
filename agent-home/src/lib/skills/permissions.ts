/**
 * Per-profile "Skills permissions" (Settings → Skills permissions): what each
 * role may do with skills. Python (`/api/access/skills`) is the authority and
 * normalises implications on write (manage ⇒ view, lab ⇒ view,
 * agent_edit ⇒ use). Pure and client-safe.
 */
import type { Role } from "@/types";

export const SKILL_ACTIONS = ["use", "view", "agent_edit", "manage", "lab"] as const;
export type SkillAction = (typeof SKILL_ACTIONS)[number];
export type SkillPermissions = Record<SkillAction, boolean>;

export interface SkillActionInfo {
  key: SkillAction;
  label: string;
  description: string;
}

export interface SkillRolePermissions {
  role: Role;
  label: string;
  /** The owner column: always everything, never editable. */
  locked: boolean;
  /** Whether the caller may change this role (the admin column is owner-only). */
  editable: boolean;
  customised: boolean;
  actions: SkillPermissions;
}

/** `GET /api/access/skills` and `PUT /api/access/skills/{role}`. */
export interface SkillsAccessResponse {
  actions: SkillActionInfo[];
  roles: SkillRolePermissions[];
}

/** `GET /api/access/skills/me`. */
export interface MySkillPermissions {
  role: string;
  actions: SkillPermissions;
}

export type SkillPermissionsChange = { actions: Partial<SkillPermissions> } | { reset: true };

/** The rows that change the agent's tools; they reach the next new chat. */
export const TOOL_SKILL_ACTIONS: readonly SkillAction[] = ["use", "agent_edit"];

export const ADMIN_SKILLS_EDIT_DENIED = "Only the owner can change what admins can do.";
export const OWNER_SKILLS_LOCKED = "The owner can always do everything with skills.";

/** Every permission on (the owner; the UI default when a caller passes none). */
export const ALL_SKILL_PERMISSIONS: Readonly<SkillPermissions> = { use: true, view: true, agent_edit: true, manage: true, lab: true };

const ALL: SkillPermissions = ALL_SKILL_PERMISSIONS;
const USE_ONLY: SkillPermissions = { use: true, view: false, agent_edit: false, manage: false, lab: false };

/** The built-in defaults (today's behaviour), used when the API has no answer. */
export function defaultSkillPermissions(role: string, isOwner = false): SkillPermissions {
  return isOwner || role === "owner" || role === "admin" ? { ...ALL } : { ...USE_ONLY };
}

export function isSkillAction(value: unknown): value is SkillAction {
  return typeof value === "string" && (SKILL_ACTIONS as readonly string[]).includes(value);
}

/** A well-formed permissions object, or null. Unknown keys are dropped. */
export function parseSkillPermissions(raw: unknown): SkillPermissions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out = {} as SkillPermissions;
  for (const key of SKILL_ACTIONS) {
    if (typeof obj[key] !== "boolean") return null;
    out[key] = obj[key] as boolean;
  }
  return out;
}

/** The actions that differ between two permission sets (e.g. implied by a toggle). */
export function changedSkillActions(before: SkillPermissions, after: SkillPermissions): SkillAction[] {
  return SKILL_ACTIONS.filter((k) => before[k] !== after[k]);
}

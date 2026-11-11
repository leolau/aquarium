/**
 * Server half of Skills permissions: what the caller may do with skills in a
 * profile (`GET /api/access/skills/me`), and the BFF check every
 * `/api/skills/*` route runs before proxying. Python re-checks; it is the
 * authority.
 */
import "server-only";

import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import {
  defaultSkillPermissions,
  parseSkillPermissions,
  type SkillAction,
  type SkillPermissions,
} from "@/lib/skills/permissions";
import type { Principal } from "@/types";

/** Shown when the caller's role may not do a skills action. */
export const SKILL_ACTION_DENIED: Record<SkillAction, string> = {
  use: "Your role can't use skills in this profile.",
  view: "Your role can't see skills in this profile.",
  agent_edit: "Your role can't ask the agent to change skills in this profile.",
  manage: "Your role can't create, edit, turn on/off or install skills in this profile.",
  lab: "Your role can't open the Skills Lab in this profile.",
};

/**
 * The caller's skill permissions in `profile` (the session's profile when
 * omitted). An API without the endpoint yet (404) gets the built-in role
 * defaults, which match what it enforces; any other failure throws.
 */
export async function getSkillPermissions(
  principal: Pick<Principal, "role" | "is_owner">,
  profile?: string,
): Promise<SkillPermissions> {
  const client = await apiClientForRequest({ profile });
  try {
    const parsed = parseSkillPermissions((await client.mySkillPermissions())?.actions);
    if (parsed) return parsed;
    throw new HermesApiError(502, "The AI layer sent unreadable skill permissions.", null);
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 404) {
      return defaultSkillPermissions(principal.role, principal.is_owner);
    }
    throw err;
  }
}

/** Like `getSkillPermissions`, but every failure yields no permissions (fail closed). */
export async function getSkillPermissionsOrNone(
  principal: Pick<Principal, "role" | "is_owner">,
  profile?: string,
): Promise<SkillPermissions> {
  try {
    return await getSkillPermissions(principal, profile);
  } catch {
    return { use: false, view: false, agent_edit: false, manage: false, lab: false };
  }
}

export type SkillPermissionCheck =
  | { ok: true; principal: Principal; permissions: SkillPermissions }
  | { ok: false; response: NextResponse };

/**
 * The check every Skills BFF handler runs first: 401 signed out, 403 when the
 * caller's role may not do `action` in `profile`, 502 when that can't be told.
 */
export async function requireSkillPermission(
  action: SkillAction,
  profile: string | undefined,
): Promise<SkillPermissionCheck> {
  const principal = await getPrincipal();
  if (!principal) {
    return { ok: false, response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  let permissions: SkillPermissions;
  try {
    permissions = await getSkillPermissions(principal, profile);
  } catch (err) {
    const status = err instanceof HermesApiError ? err.status : 502;
    const detail = err instanceof Error ? err.message : "The AI layer could not be reached.";
    return {
      ok: false,
      response: NextResponse.json(
        { error: status === 401 || status === 403 ? "forbidden" : "api_error", detail },
        { status },
      ),
    };
  }
  if (!permissions[action]) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "forbidden", action, detail: SKILL_ACTION_DENIED[action] },
        { status: 403 },
      ),
    };
  }
  return { ok: true, principal, permissions };
}

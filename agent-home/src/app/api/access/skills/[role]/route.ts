/**
 * /api/access/skills/[role] — PUT {actions: {<key>: bool}} changes some of a
 * role's skill permissions; PUT {reset: true} goes back to the defaults. The
 * owner column is locked; only the owner may change the admin column. Python
 * re-checks and normalises implications (manage ⇒ view, …).
 */
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { BAD_JSON, badRequest, readJsonBody, refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { SKILLS_PERMISSIONS_CACHE_TAG } from "@/lib/nav/hidden-apps";
import {
  ADMIN_SKILLS_EDIT_DENIED,
  isSkillAction,
  OWNER_SKILLS_LOCKED,
  type SkillPermissions,
  type SkillPermissionsChange,
} from "@/lib/skills/permissions";

const EDITABLE_ROLES = ["admin", "member", "viewer"];

export async function PUT(request: Request, { params }: { params: Promise<{ role: string }> }) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { role } = await params;
  if (role === "owner") return badRequest(OWNER_SKILLS_LOCKED);
  if (!EDITABLE_ROLES.includes(role)) return badRequest("Unknown role.");
  if (role === "admin" && !(principal.is_owner || principal.role === "owner")) {
    return NextResponse.json({ error: "forbidden", detail: ADMIN_SKILLS_EDIT_DENIED }, { status: 403 });
  }
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  let change: SkillPermissionsChange;
  if (body.reset === true) {
    change = { reset: true };
  } else if (body.actions && typeof body.actions === "object" && !Array.isArray(body.actions)) {
    const entries = Object.entries(body.actions as Record<string, unknown>);
    if (entries.length === 0 || !entries.every(([k, v]) => isSkillAction(k) && typeof v === "boolean")) {
      return badRequest("actions must map use, view, agent_edit, manage or lab to true/false.");
    }
    change = { actions: Object.fromEntries(entries) as Partial<SkillPermissions> };
  } else {
    return badRequest("Send actions ({key: true/false}) or reset: true.");
  }
  const client = await apiClientForRequest();
  return upstream(async () => {
    const saved = await client.setSkillPermissions(role, change);
    // The launcher's Skills tile follows `view`; don't wait out the cache.
    revalidateTag(SKILLS_PERMISSIONS_CACHE_TAG);
    return saved;
  });
}

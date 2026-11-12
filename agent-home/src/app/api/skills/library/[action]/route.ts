/**
 * POST /api/skills/library/{add,remove,delete} — change one Agent Profile's
 * skills (owner/admin only, like Agent Profiles; Python re-checks and audits).
 * `target` names the profile; `where` (`shared` | `only`) answers the copy
 * question for a skill that only exists in another profile.
 */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { SkillCopyChoice, SkillLibraryAction } from "@/types";

const ACTIONS: readonly SkillLibraryAction[] = ["add", "remove", "delete"];

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { action } = await params;
  if (!ACTIONS.includes(action as SkillLibraryAction)) return badRequest("Unknown skills action.");
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const target = str(body.target);
  const name = str(body.name);
  if (!target || !name) return badRequest("target and name are required.");
  const where = body.where === "shared" || body.where === "only" ? (body.where as SkillCopyChoice) : undefined;
  const client = await apiClientForRequest();
  return upstream(() =>
    client.changeProfileSkill(action as SkillLibraryAction, { target, name, ...(where ? { where } : {}) }),
  );
}

/**
 * GET /api/skills/library — the box-wide skills library behind the Skills
 * page and each Agent Profile's Skills panel: every skill once, with its
 * source and which profiles use it (on/off). Skills `view` permission.
 */
import { upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET() {
  const gate = await requireSkillPermission("view", undefined);
  if (!gate.ok) return gate.response;
  const client = await apiClientForRequest();
  return upstream(() => client.skillLibrary());
}

/** POST /api/skills/versions/activate — make a version the live one, optionally as a trial (Skills permissions). */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { toVersionList } from "@/lib/skills/versions";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("lab", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  const id = str(body.id);
  if (!name || !id) return badRequest("name and id are required.");
  if (body.trial !== undefined && typeof body.trial !== "boolean") return badRequest("trial must be true or false.");
  const trial = body.trial === true;
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.activateSkillVersion({ name, id, trial }),
    (data) => {
      const list = toVersionList(data, name);
      return { active: list.active, versions: list.versions };
    },
  );
}

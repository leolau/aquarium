/** GET /api/skills/versions/detail — one version's SKILL.md and file list (owner/admin). */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";
import { toVersionMeta, type SkillVersionDetail } from "@/lib/skills/versions";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const params = new URL(request.url).searchParams;
  const name = str(params.get("name"));
  const id = str(params.get("id"));
  if (!name || !id) return badRequest("name and id are required.");
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(
    () => client.skillVersionDetail(name, id),
    (data: SkillVersionDetail): SkillVersionDetail => ({
      meta: toVersionMeta(data.meta),
      content: typeof data.content === "string" ? data.content : "",
      // File paths stay relative to the skill folder.
      files: (data.files ?? []).map((f) => ({ path: f.path, size: f.size })),
    }),
  );
}

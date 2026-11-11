/** GET /api/skills/improve/sessions — past improve chats for one skill; `?project=` keeps one project's (Skills permissions). */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { PROJECT_SLUG, type ImproveSession } from "@/lib/skills/improve";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("lab", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const params = new URL(request.url).searchParams;
  const name = str(params.get("name"));
  if (!name) return badRequest("name is required.");
  const project = str(params.get("project"));
  if (project && !PROJECT_SLUG.test(project)) return badRequest("project is not a valid project slug.");
  const query = `name=${encodeURIComponent(name)}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(
    () => client.request<ImproveSession[]>(`/api/skills/improve/sessions?${query}`),
    (data): ImproveSession[] =>
      (Array.isArray(data) ? data : []).map((s) => ({
        session_id: String(s.session_id),
        title: typeof s.title === "string" ? s.title : null,
        started_at: s.started_at ?? null,
        drafts: Number(s.drafts) || 0,
      })),
  );
}

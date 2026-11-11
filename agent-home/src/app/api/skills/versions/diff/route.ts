/** GET /api/skills/versions/diff — unified diff between two versions (Skills permissions). */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import type { SkillVersionDiff } from "@/lib/skills/versions";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("lab", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const params = new URL(request.url).searchParams;
  const name = str(params.get("name"));
  const a = str(params.get("a"));
  const b = str(params.get("b"));
  if (!name || !a || !b) return badRequest("name, a and b are required.");
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(
    () => client.skillVersionDiff(name, a, b),
    (data: SkillVersionDiff): SkillVersionDiff => ({
      a: data.a ?? a,
      b: data.b ?? b,
      diff: typeof data.diff === "string" ? data.diff : "",
    }),
  );
}

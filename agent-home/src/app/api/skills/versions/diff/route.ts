/** GET /api/skills/versions/diff — unified diff between two versions (owner/admin). */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";
import type { SkillVersionDiff } from "@/lib/skills/versions";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
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

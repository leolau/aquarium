/** PUT /api/profiles/named/[name]/description — owner/admin only. */
import { BAD_JSON, readJsonBody, refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const description = typeof body.description === "string" ? body.description : "";
  const client = await apiClientForRequest();
  return upstream(() => client.setProfileDescription(name, description));
}

/** POST /api/profiles/named/[name]/describe-auto — let the AI write the description. */
import { readJsonBody, refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ name: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const body = (await readJsonBody(request)) ?? {};
  const client = await apiClientForRequest();
  return upstream(() => client.describeProfileAuto(name, body.overwrite === true));
}

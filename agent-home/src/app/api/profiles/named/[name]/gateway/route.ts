/** POST /api/profiles/named/[name]/gateway — start a profile's message handling (owner/admin). */
import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ name: string }> };

export async function POST(_request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const client = await apiClientForRequest();
  return upstream(() => client.startProfileGateway(name));
}

/** PUT /api/profiles/named/[name]/model — a profile's main model (owner/admin). */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const provider = str(body.provider);
  const model = str(body.model);
  if (!provider || !model) return badRequest("Pick a provider and a model.");
  const client = await apiClientForRequest();
  return upstream(() => client.setProfileModel(name, provider, model));
}

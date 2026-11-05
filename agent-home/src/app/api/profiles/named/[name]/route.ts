/** PATCH (rename) / DELETE /api/profiles/named/[name] — owner/admin only. */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ name: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const newName = str(body.new_name);
  if (!newName) return badRequest("Pick a new name.");
  const client = await apiClientForRequest();
  return upstream(() => client.renameProfile(name, newName));
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const client = await apiClientForRequest();
  return upstream(() => client.deleteProfile(name));
}

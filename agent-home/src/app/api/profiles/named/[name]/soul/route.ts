/** GET/PUT /api/profiles/named/[name]/soul — a profile's SOUL.md (owner/admin). */
import { BAD_JSON, readJsonBody, refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const client = await apiClientForRequest();
  return upstream(
    () => client.profileSoul(name),
    (data) => ({ content: typeof data.content === "string" ? data.content : "" }),
  );
}

export async function PUT(request: Request, ctx: Ctx) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const { name } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body || typeof body.content !== "string") return BAD_JSON();
  const content = body.content;
  const client = await apiClientForRequest();
  return upstream(() => client.setProfileSoul(name, content));
}

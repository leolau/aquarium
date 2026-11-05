/**
 * GET/POST /api/profiles — the owner/admin Profiles page. Lists every profile
 * on the box (filesystem paths stripped) and creates one in a single POST
 * (Python `ProfileCreate`: clone source, model, kept and hub skills).
 */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { toProfileInfo } from "@/lib/api/profile-info";
import type { ProfileCreateInput } from "@/types";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const client = await apiClientForRequest();
  return upstream(
    () => client.profileInfos(),
    (data) => ({ profiles: (data.profiles ?? []).map(toProfileInfo) }),
  );
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const name = str(body.name);
  if (!name) return badRequest("A profile needs a name.");
  const input: ProfileCreateInput = {
    name,
    clone_from: str(body.clone_from) || null,
    clone_all: body.clone_all === true,
    no_skills: body.no_skills === true,
    description: str(body.description) || undefined,
    provider: str(body.provider) || undefined,
    model: str(body.model) || undefined,
    keep_skills: strings(body.keep_skills),
    hub_skills: strings(body.hub_skills),
  };
  const client = await apiClientForRequest();
  return upstream(
    () => client.createProfile(input),
    (data) => ({
      ok: data.ok,
      name: data.name,
      model_set: data.model_set,
      skills_disabled: data.skills_disabled,
      hub_installs: data.hub_installs ?? [],
    }),
  );
}

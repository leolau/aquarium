import { redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { ProfilesView } from "@/components/profiles/ProfilesView";
import { getT } from "@/i18n/server";
import { toProfileInfo } from "@/lib/api/profile-info";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { ModelProviderOption, ProfileInfo } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Profiles — every agent on this box (each its own soul, model, skills,
 * memory and credentials). Owner/admin only: the menu hides it from members
 * and viewers, the middleware blocks the URL, and this check is the last
 * line before the Python `_ADMIN` gate.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("system");
  if (!canAdminister(principal)) redirect("/not-available?app=profiles");

  let profiles: ProfileInfo[] = [];
  let providers: ModelProviderOption[] = [];
  let error: string | null = null;
  const client = await apiClientForRequest();
  const [list, options] = await Promise.allSettled([client.profileInfos(), client.modelOptions()]);
  if (list.status === "fulfilled") {
    profiles = (list.value.profiles ?? []).map(toProfileInfo);
  } else {
    error = list.reason instanceof Error ? list.reason.message : "Failed to load profiles";
  }
  if (options.status === "fulfilled") {
    providers = (options.value.providers ?? []).filter((p) => p.models.length > 0);
  }

  return (
    <MobileShell title={t("cards.profiles.name")} subtitle={t("pages.profiles.subtitle")} wide>
      <ProfilesView initialProfiles={profiles} providers={providers} error={error} />
    </MobileShell>
  );
}

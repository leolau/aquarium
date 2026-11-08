import { getT } from "@/i18n/server";
import { MobileShell } from "@/components/MobileShell";
import { ProfileSuggestionsView } from "@/components/profiles/ProfileSuggestionsView";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type {
  ProfileSuggestion,
  ProfileSuggestionSummary,
  ProfileSuggestionsResponse,
} from "@/types";

// Reads the live principal (cookie) + this profile's suggestions per request.
// Never at build time — the row is profile-local (§1.4) and the adopt path
// mutates the goal tree, so a cached render would lie about the queue.
export const dynamic = "force-dynamic";

/**
 * FG-30 §4.2 T1 — the **Profile suggestions** screen.
 *
 * The FG's actual user-facing surface. Per §4.1 the queue is **profile-local**:
 * `profile_suggestions` FKs profile-local `goals`/`principals`, and FG-28 has
 * not shipped a profile switcher, so this page shows *this* profile's
 * suggestions only — there is no cross-profile view to build here.
 *
 * Any enrolled principal may read the queue (a member can see a proposed
 * sub-goal of the work they are in). Only the owner gets adopt/dismiss; the
 * Python layer is the authority on that, returning 403 for a non-owner — the
 * buttons are hidden here for a clean UX, but the 403 is the real gate, not a
 * BFF re-derivation (the #253 hazard).
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("system");

  let suggestions: ProfileSuggestion[] = [];
  let reviewed: ProfileSuggestionSummary[] = [];
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const resp: ProfileSuggestionsResponse = await client.profileSuggestions();
    suggestions = resp.suggestions ?? [];
    reviewed = resp.reviewed ?? [];
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load suggestions";
  }

  return (
    <MobileShell title={t("pages.suggestions.title")} subtitle={t("pages.suggestions.subtitle")}>
      <ProfileSuggestionsView
        role={principal.role}
        suggestions={suggestions}
        reviewed={reviewed}
        error={error}
      />
    </MobileShell>
  );
}
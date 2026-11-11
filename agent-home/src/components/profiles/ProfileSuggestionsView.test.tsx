import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProfileSuggestionsView } from "@/components/profiles/ProfileSuggestionsView";
import type { ProfileSuggestion, ProfileSuggestionSummary } from "@/types";

const OPEN: ProfileSuggestion = {
  id: "s1",
  proposed_name: "finance",
  proposed_role: "CFO",
  proposed_goal: "improve cashflow",
  parent_goal_id: null,
  rationale: "Three weeks of cashflow work sits outside any sub-goal.",
  evidence: { participants: [{ user_id: "mia", role: "member" }] },
  dedup_key: "k1",
  origin_profile: "default",
  status: "proposed",
  reviewed_by: null,
  reviewed_at: null,
  created_at: "2026-08-15T00:00:00Z",
};

const REVIEWED: ProfileSuggestionSummary[] = [
  {
    id: "s0",
    proposed_name: "marketing",
    proposed_role: "CMO",
    proposed_goal: "grow the funnel",
    status: "dismissed",
    reviewed_by: "leo",
    reviewed_at: "2026-07-20T00:00:00Z",
    created_at: "2026-07-01T00:00:00Z",
  },
];

describe("ProfileSuggestionsView", () => {
  it("renders the reviewed trail from `reviewed`, not from a status filter", () => {
    // The F1 property: with no open card the trail is still the trace of what
    // the owner just did, so an adopt does not leave a blank screen.
    const html = renderToStaticMarkup(
      <ProfileSuggestionsView
        role="owner"
        suggestions={[]}
        reviewed={REVIEWED}
        error={null}
      />,
    );
    expect(html).toContain("ReviewedHistory");
    expect(html).toContain("CMO");
    expect(html).toContain("dismissed");
    expect(html).toContain("Nothing waiting for you");
  });

  it("renders the trail without needing evidence on those rows", () => {
    // `ProfileSuggestionSummary` has no `evidence` — the roster it carries is
    // dropped server-side (§4.2 T3), so the trail must not read it.
    const html = renderToStaticMarkup(
      <ProfileSuggestionsView
        role="member"
        suggestions={[]}
        reviewed={REVIEWED}
        error={null}
      />,
    );
    expect(html).not.toContain("participants");
    expect(html).not.toContain("mia");
  });

  it("shows the open card with its evidence, and both role and goal", () => {
    const html = renderToStaticMarkup(
      <ProfileSuggestionsView
        role="owner"
        suggestions={[OPEN]}
        reviewed={REVIEWED}
        error={null}
      />,
    );
    expect(html).toContain("CFO");
    expect(html).toContain("improve cashflow");
    expect(html).toContain("Evidence");
    expect(html).toContain("Adopt");
  });

  it("is empty only when neither an open card nor a trail exists", () => {
    const empty = renderToStaticMarkup(
      <ProfileSuggestionsView
        role="owner"
        suggestions={[]}
        reviewed={[]}
        error={null}
      />,
    );
    expect(empty).toContain("SuggestionsEmpty");

    const trailOnly = renderToStaticMarkup(
      <ProfileSuggestionsView
        role="owner"
        suggestions={[]}
        reviewed={REVIEWED}
        error={null}
      />,
    );
    expect(trailOnly).not.toContain("SuggestionsEmpty");
  });

  it("keeps the root marker in every loaded state and drops it on a load error", () => {
    const states = [
      { suggestions: [], reviewed: [] },
      { suggestions: [], reviewed: REVIEWED },
      { suggestions: [OPEN], reviewed: [] },
      { suggestions: [OPEN], reviewed: REVIEWED },
    ];
    for (const { suggestions, reviewed } of states) {
      const html = renderToStaticMarkup(
        <ProfileSuggestionsView role="member" suggestions={suggestions} reviewed={reviewed} error={null} />,
      );
      expect(html).toContain('data-component="ProfileSuggestionsView"');
    }

    const failed = renderToStaticMarkup(
      <ProfileSuggestionsView role="owner" suggestions={[]} reviewed={[]} error="upstream 500" />,
    );
    expect(failed).toContain("SuggestionsError");
    expect(failed).not.toContain('data-component="ProfileSuggestionsView"');
  });

  it("hides adopt/dismiss for a non-owner (the 403 upstream is the real gate)", () => {
    const html = renderToStaticMarkup(
      <ProfileSuggestionsView
        role="member"
        suggestions={[OPEN]}
        reviewed={[]}
        error={null}
      />,
    );
    expect(html).not.toContain(">Adopt<");
    expect(html).toContain("Only the owner can adopt or dismiss");
  });
});

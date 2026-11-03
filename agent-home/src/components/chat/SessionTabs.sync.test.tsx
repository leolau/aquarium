// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionTabs } from "@/components/chat/SessionTabs";
import type { SessionSummary } from "@/types";

afterEach(cleanup);

const NOW = Math.floor(Date.now() / 1000);

function session(id: string, title: string, startedAt: number): SessionSummary {
  return {
    id,
    source: "agent_home",
    title,
    preview: null,
    message_count: 0,
    started_at: startedAt,
    last_active: null,
    ended_at: null,
  };
}

const props = {
  busyKeys: [],
  onSelect: () => {},
  onOpenDetails: () => {},
  onNew: () => {},
  onReorder: () => {},
};

describe("SessionTabs category follows the active conversation", () => {
  it("jumps once a new conversation shows up in the list after it became active", () => {
    const old = session("old", "Old chat", NOW - 10 * 86400);
    const fresh = session("fresh", "Fresh chat", NOW);
    const { rerender } = render(<SessionTabs {...props} sessions={[old]} activeId="old" />);
    expect(screen.getByRole("button", { name: 'Edit conversation "Old chat"' })).toBeTruthy();

    // The send makes it active before the session list refetch includes it.
    rerender(<SessionTabs {...props} sessions={[old]} activeId="fresh" />);
    rerender(<SessionTabs {...props} sessions={[fresh, old]} activeId="fresh" />);

    expect(screen.getByRole("button", { name: 'Edit conversation "Fresh chat"' })).toBeTruthy();
  });
});

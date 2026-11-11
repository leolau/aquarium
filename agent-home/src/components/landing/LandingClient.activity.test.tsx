// @vitest-environment jsdom
/**
 * F2: the landing page polls `/api/activity/running` once. The top bar's
 * running strip, the mobile strip and "Working in the background" all render
 * the same `useActivityRunning` read.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/chat/session-list-fetch", () => ({ fetchSessionList: async () => null }));
vi.mock("@/components/ui/useStatusSummary", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/useStatusSummary")>()),
  useStatusSummary: () => ({
    summary: null,
    stale: false,
    fetchedAt: null,
    now: 0,
    refreshing: false,
    refresh: async () => {},
  }),
}));
vi.mock("@/lib/landing/needsYou", () => ({
  useNeedsYou: () => ({
    items: [],
    count: 0,
    newIds: [],
    loading: false,
    stale: false,
    refresh: () => {},
    markSeen: () => {},
    bySeverity: { blocking: 0 },
  }),
}));
vi.mock("./chats", async (orig) => ({
  ...(await orig<typeof import("./chats")>()),
  ChatsSidebar: () => null,
  ChatsDrawer: () => null,
}));

import { resetActivityRunningCache } from "@/components/ui/useActivityRunning";

import { LandingClient } from "./LandingClient";
import { MOCK_ACTIVITY, MOCK_SCHEDULED } from "./topbar/mockData";

afterEach(() => {
  cleanup();
  resetActivityRunningCache();
  vi.restoreAllMocks();
});

describe("LandingClient activity", () => {
  it("reads /api/activity/running exactly once with the work panel mounted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("/api/activity/running")) {
        return new Response(JSON.stringify({ items: MOCK_ACTIVITY, scheduled: MOCK_SCHEDULED }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    render(<LandingClient profiles={[{ name: "default", is_default: true }] as never} currentProfile="default" />);
    const panel = await waitFor(() => {
      const el = document.querySelector('[data-component="WorkPanel"]');
      expect(el?.querySelectorAll('[data-component="WorkRow"]').length).toBe(MOCK_ACTIVITY.length);
      return el!;
    });
    expect(panel).toBeTruthy();
    expect(document.querySelectorAll('[data-component="RunningStrip"] [role="listitem"]')).toHaveLength(
      MOCK_ACTIVITY.length,
    );
    expect(screen.getAllByTestId("scheduled-count")[0].textContent).toBe("6");
    const activityCalls = fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("/api/activity/running"));
    expect(activityCalls).toHaveLength(1);
  });
});

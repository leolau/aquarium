// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetActivityRunningCache } from "@/components/ui/useActivityRunning";
import { resetStatusSummaryCache } from "@/components/ui/useStatusSummary";

import { MOCK_ACTIVITY, MOCK_NEEDS_YOU, MOCK_SUMMARY, mockActivity, mockStatus } from "./mockData";
import { TopBar, TopBarView } from "./TopBar";
import { resetNeedsYouCache } from "./useNeedsYou";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  resetStatusSummaryCache();
  resetActivityRunningCache();
  resetNeedsYouCache();
  vi.restoreAllMocks();
});

const needsYou = { count: 3, blocking: 1, items: MOCK_NEEDS_YOU, stale: false };

describe("TopBarView", () => {
  it("has the mark, health, needs-you badge and account control", () => {
    const onOpen = vi.fn();
    render(
      <TopBarView status={mockStatus()} activity={mockActivity()} needsYou={needsYou} onOpenNeedsYou={onOpen} />,
    );
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Aquarium")).toBeTruthy();
    expect(header.querySelectorAll('[data-component="HealthPill"]')).toHaveLength(2);
    expect(within(header).getByRole("button", { name: /Account/ })).toBeTruthy();
    const badges = header.querySelectorAll<HTMLButtonElement>('[data-component="NeedsYouBadge"]');
    expect(badges).toHaveLength(2);
    badges.forEach((b) => fireEvent.click(b));
    fireEvent.click(screen.getByText("See all"));
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("renders the mobile activity strip and attention banner below the bar", () => {
    render(<TopBarView status={mockStatus()} activity={mockActivity()} needsYou={needsYou} />);
    expect(screen.getByTestId("activity-count").textContent).toContain("4 working");
    expect(document.querySelector('[data-component="AttentionBanner"][data-blocking]')).toBeTruthy();
  });

  it("uses a supplied account slot and shows the sidebar toggle when asked", () => {
    const toggle = vi.fn();
    render(
      <TopBarView
        status={mockStatus()}
        activity={mockActivity({ items: [] })}
        needsYou={{ count: 0, blocking: 0, items: [], stale: false }}
        account={<span>custom account</span>}
        onToggleSidebar={toggle}
      />,
    );
    expect(screen.getByText("custom account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Account/ })).toBeNull();
    expect(document.querySelector('[data-component="MobileActivityStrip"]')).toBeNull();
    expect(document.querySelector('[data-component="AttentionBanner"]')).toBeNull();
    fireEvent.click(screen.getByLabelText("Toggle chats"));
    expect(toggle).toHaveBeenCalledOnce();
  });
});

describe("TopBar", () => {
  it("reads status, activity and needs-you through the shared hooks", async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/status/summary")) return json(MOCK_SUMMARY);
      if (url.startsWith("/api/activity/running")) return json({ items: MOCK_ACTIVITY });
      if (url.startsWith("/api/needs-you"))
        return json({ items: MOCK_NEEDS_YOU, count: 3, by_severity: { blocking: 1, approval: 1, review: 1, fyi: 0 }, collected_at: 1 });
      return new Response("nope", { status: 404 });
    });
    render(<TopBar />);
    expect(await screen.findByText("3 need you")).toBeTruthy();
    expect(await screen.findByText("23%")).toBeTruthy();
    expect((await screen.findByTestId("activity-count")).textContent).toContain("4 working");
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.startsWith("/api/status/summary"))).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith("/api/activity/running"))).toHaveLength(1);
  });

  it("still renders the bar when the needs-you route is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 404 }));
    render(<TopBar />);
    await waitFor(() =>
      expect(document.querySelector('[data-component="NeedsYouBadge"]')!.getAttribute("data-stale")).toBe("true"),
    );
    expect(screen.getByRole("banner")).toBeTruthy();
  });
});

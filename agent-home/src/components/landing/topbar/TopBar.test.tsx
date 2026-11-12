// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetActivityRunningCache } from "@/components/ui/useActivityRunning";
import { resetStatusSummaryCache } from "@/components/ui/useStatusSummary";

import {
  MOCK_ACTIVITY,
  MOCK_NEEDS_YOU,
  MOCK_SCHEDULED,
  MOCK_SUMMARY,
  mockActivity,
  mockStatus,
} from "./mockData";
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
    expect(within(header).getByRole("link", { name: "Open the Aquarium dashboard" }).getAttribute("href")).toBe("/aquarium");
    expect(header.querySelectorAll('[data-component="HealthPill"]')).toHaveLength(3);
    expect(header.querySelector('[data-fit-show="health"] [data-component="HealthPill"]')?.getAttribute("data-variant")).toBe(
      "compact",
    );
    for (const step of ["updated", "aquarium-label", "health", "needs-text", "identity", "brand-label"]) {
      expect(header.querySelector(`[data-fit-hide="${step}"]`), step).toBeTruthy();
    }
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

  it("renders the desktop running strip under the header with the Scheduled button", () => {
    render(
      <TopBarView status={mockStatus()} activity={mockActivity({ scheduled: MOCK_SCHEDULED })} needsYou={needsYou} />,
    );
    const strip = document.querySelector('[data-component="RunningStrip"]')!;
    expect(strip.className).toContain("hidden lg:flex");
    expect(screen.getByRole("banner").contains(strip)).toBe(false);
    expect(strip.querySelectorAll('[role="listitem"]')).toHaveLength(MOCK_ACTIVITY.length);
    const buttons = document.querySelectorAll('[data-component="ScheduledButton"]');
    expect([...buttons].map((b) => b.getAttribute("data-variant"))).toEqual(["full", "compact"]);
  });

  it("uses a supplied account slot", () => {
    render(
      <TopBarView
        status={mockStatus()}
        activity={mockActivity({ items: [] })}
        needsYou={{ count: 0, blocking: 0, items: [], stale: false }}
        account={<span>custom account</span>}
      />,
    );
    expect(screen.getByText("custom account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Account/ })).toBeNull();
    expect(document.querySelector('[data-component="MobileActivityStrip"]')).toBeNull();
    expect(document.querySelector('[data-component="RunningStrip"]')).toBeNull();
    expect(document.querySelector('[data-component="AttentionBanner"]')).toBeNull();
  });

  it("has no panel toggle beside the logo and shows the account name and role", () => {
    render(
      <TopBarView
        status={mockStatus()}
        activity={mockActivity()}
        needsYou={needsYou}
        accountName="Yan"
        accountRole="owner"
      />,
    );
    const brand = document.querySelector('[data-component="brand"]')!;
    expect(brand.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector('[data-action="toggle-sidebar"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Account: Yan, Owner" })).toBeTruthy();
    expect(screen.getByTestId("account-identity").textContent).toBe("YanOwner");
  });
});

describe("TopBar", () => {
  it("reads status, activity and needs-you through the shared hooks", async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/status/summary")) return json(MOCK_SUMMARY);
      if (url.startsWith("/api/activity/running")) return json({ items: MOCK_ACTIVITY, scheduled: MOCK_SCHEDULED });
      if (url.startsWith("/api/needs-you"))
        return json({ items: MOCK_NEEDS_YOU, count: 3, by_severity: { blocking: 1, approval: 1, review: 1, fyi: 0 }, collected_at: 1 });
      return new Response("nope", { status: 404 });
    });
    render(<TopBar />);
    expect((await screen.findAllByRole("button", { name: /^3 items need you/ })).map((b) => b.textContent)).toContain(
      "3 need you",
    );
    expect(await screen.findByText("23%")).toBeTruthy();
    expect((await screen.findByTestId("activity-count")).textContent).toContain("4 working");
    expect((await screen.findByTestId("running-count")).textContent).toBe("4");
    expect(screen.getAllByTestId("scheduled-count").map((n) => n.textContent)).toEqual(["6", "6"]);
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

describe("TopBarView compact (phone chat page)", () => {
  it("folds the activity strip and attention card into the bar, keeping one blocking line", () => {
    const onOpen = vi.fn();
    render(
      <TopBarView compact status={mockStatus()} activity={mockActivity()} needsYou={needsYou} onOpenNeedsYou={onOpen} />,
    );
    expect(document.querySelector('[data-component="MobileActivityStrip"]')).toBeNull();
    expect(document.querySelector('[data-component="AttentionBanner"]')).toBeNull();
    const pill = screen.getByRole("button", { name: "4 working — show what's running" });
    expect(pill.textContent).toContain("4");
    expect(screen.getByRole("button", { name: "Open Aquarium menu" })).toBeTruthy();
    const strip = document.querySelector<HTMLButtonElement>('[data-component="AttentionStrip"]')!;
    expect(strip.textContent).toContain("1 blocking");
    expect(strip.className).toContain("h-11");
    fireEvent.click(strip);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(pill);
    expect(document.querySelector('[data-component="ActivitySheet"]')).toBeTruthy();
  });

  it("shows no strip when nothing blocks — the bell carries the count", () => {
    const calm = { ...needsYou, blocking: 0, items: MOCK_NEEDS_YOU.filter((i) => i.severity !== "blocking") };
    render(<TopBarView compact status={mockStatus()} activity={mockActivity()} needsYou={calm} />);
    expect(document.querySelector('[data-component="AttentionStrip"]')).toBeNull();
    expect(document.querySelectorAll('[data-component="NeedsYouBadge"]').length).toBeGreaterThan(0);
  });

  it("keeps the full layout when not compact", () => {
    render(<TopBarView status={mockStatus()} activity={mockActivity()} needsYou={needsYou} />);
    expect(document.querySelector('[data-component="ActivityPill"]')).toBeNull();
    expect(document.querySelector('[data-component="CoralMenuButton"]')).toBeNull();
    expect(document.querySelector('[data-component="AttentionStrip"]')).toBeNull();
  });
});

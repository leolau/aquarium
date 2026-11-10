// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HealthPill } from "./HealthPill";
import { MOCK_SUMMARY, mockActivity, mockStatus } from "./mockData";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_HERMES_BUILD", "abc1234");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("HealthPill (desktop bar)", () => {
  it("shows the verdict, the key readings and freshness", () => {
    vi.stubEnv("NEXT_PUBLIC_HERMES_BUILD", "abc1234");
    render(<HealthPill variant="bar" status={mockStatus()} activity={mockActivity()} />);
    const root = document.querySelector('[data-component="HealthPill"]')!;
    expect(root.getAttribute("data-verdict")).toBe("ok");
    expect(screen.getByText("23%")).toBeTruthy();
    expect(screen.getByText("41%")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy(); // live: 2 chats + 2 cards
    expect(screen.getByText("3 / 5")).toBeTruthy();
    expect(screen.getByTestId("health-freshness").textContent).toBe("Updated 12s ago");
  });

  it("opens a popover with every reading and what's running; Esc closes it", () => {
    vi.stubEnv("NEXT_PUBLIC_HERMES_BUILD", "abc1234");
    render(<HealthPill variant="bar" status={mockStatus()} activity={mockActivity()} />);
    fireEvent.click(screen.getByRole("button", { name: /show all readings/ }));
    const dialog = screen.getByRole("dialog", { name: "System health" });
    expect(within(dialog).getByText("48%")).toBeTruthy(); // memory
    expect(within(dialog).getByText("120.0 GB free of 500.0 GB")).toBeTruthy();
    expect(within(dialog).getByText("Plan the Q3 launch")).toBeTruthy();
    expect(within(dialog).getByTitle(/agent-home build abc1234/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refreshes on ↻", () => {
    const refresh = vi.fn(async () => {});
    render(<HealthPill variant="bar" status={mockStatus({ refresh })} />);
    fireEvent.click(screen.getByLabelText("Refresh now"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the last good readings when a read fails, marked retrying", () => {
    render(<HealthPill variant="bar" status={mockStatus({ stale: true })} />);
    expect(screen.getByText("23%")).toBeTruthy();
    expect(screen.getByTestId("health-freshness").textContent).toContain("retrying");
    expect(document.querySelector('[data-verdict="degraded"]')).toBeTruthy();
  });

  it("flags a build mismatch with a reload prompt", () => {
    vi.stubEnv("NEXT_PUBLIC_HERMES_BUILD", "old999");
    render(<HealthPill variant="bar" status={mockStatus()} />);
    const btn = screen.getByText("update abc1234 · refresh");
    expect(btn.getAttribute("title")).toContain("old999");
  });

  it("warns about low upload storage", () => {
    const summary = {
      ...MOCK_SUMMARY,
      upload_storage: { ...MOCK_SUMMARY.upload_storage!, free_bytes: 2 * 1024 ** 3, low: true },
    };
    render(<HealthPill variant="bar" status={mockStatus({ summary })} />);
    fireEvent.click(screen.getByText("Low storage"));
    expect(screen.getByRole("alert").textContent).toContain("2.0 GB free");
  });
});

describe("HealthPill (mobile compact)", () => {
  it("shows the verdict and opens the readings in a sheet", () => {
    render(<HealthPill variant="compact" status={mockStatus()} activity={mockActivity()} />);
    const pill = screen.getByRole("button", { name: /System health: Healthy/ });
    expect(pill.textContent).toContain("Healthy");
    fireEvent.click(pill);
    const sheet = document.querySelector('[data-component="HealthSheet"]')!;
    expect(sheet).toBeTruthy();
    expect(within(sheet as HTMLElement).getByText("48%")).toBeTruthy();
  });

  it("keeps the verdict word off phone widths so the top bar never scrolls sideways", () => {
    render(<HealthPill variant="compact" status={mockStatus({ summary: null, fetchedAt: null, stale: true })} />);
    const word = screen.getByText("Offline");
    expect(word.className).toContain("hidden");
    expect(word.className).toContain("sm:inline");
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/System health: Offline/);
  });

  it("reads Offline when the server can't be reached at all", () => {
    render(<HealthPill variant="compact" status={mockStatus({ summary: null, fetchedAt: null, stale: true })} />);
    expect(screen.getByRole("button").textContent).toContain("Offline");
  });
});

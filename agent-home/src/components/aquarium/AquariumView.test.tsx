// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SNAPSHOT_POLL_MS, type AquariumSnapshot } from "@/lib/aquarium/creatures";

import { AquariumView, SHAKE_MS } from "./AquariumView";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const SNAPSHOT: AquariumSnapshot = {
  generated_at: 1,
  idle_seconds: 30,
  users: [
    {
      user_id: "u1",
      name: "Ann",
      creature: "octopus",
      is_self: true,
      metrics: { chats: 4, projects: 1, tokens_in: 100, tokens_out: 50, tokens_24h: 10, active_now: true },
      profiles: [{ name: "default", display_name: "Default" }],
    },
    {
      user_id: "u2",
      name: "Bo",
      creature: "shark",
      is_self: false,
      metrics: { chats: 0, projects: 0, tokens_in: 0, tokens_out: 0, tokens_24h: 0, active_now: false },
      profiles: [],
    },
  ],
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.useFakeTimers();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AquariumView", () => {
  it("renders the scene, back link and legend, and lists people from GET /api/aquarium", async () => {
    const fetchMock = vi.fn(async () => respond(SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AquariumView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/aquarium", expect.objectContaining({ cache: "no-store" }));
    expect(container.querySelector('[data-component="AquariumView"]')).not.toBeNull();
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(screen.getByText("Back").closest("a")?.getAttribute("href")).toBe("/");
    expect(screen.getByText("How to read the aquarium")).toBeTruthy();
    const people = container.querySelector('[data-component="AquariumPeople"]')!;
    expect(people.textContent).toContain("Ann, Octopus: 4 chats, 1 profiles");
    expect(people.textContent).toContain("Bo, Shark");
    expect(container.querySelector('[data-component="AquariumOffline"]')).toBeNull();
  });

  it("keeps the last state and shows the offline badge when a poll fails, then recovers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(SNAPSHOT))
      .mockResolvedValueOnce(respond({ detail: "down" }, 502))
      .mockResolvedValue(respond(SNAPSHOT));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AquariumView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS);
    });
    expect(container.querySelector('[data-component="AquariumOffline"]')).not.toBeNull();
    expect(container.querySelector('[data-component="AquariumPeople"]')!.textContent).toContain("Ann");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS);
    });
    expect(container.querySelector('[data-component="AquariumOffline"]')).toBeNull();
  });

  it("says so when nobody is in the tank", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond({ generated_at: 1, idle_seconds: 30, users: [] })));
    const { container } = render(<AquariumView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('[data-component="AquariumEmpty"]')).not.toBeNull();
  });

  it("shows the two play tips and remembers when they are dismissed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(SNAPSHOT)));
    const { unmount } = render(<AquariumView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Try this")).toBeTruthy();
    expect(screen.getByText("Click anywhere: your creature swims there")).toBeTruthy();
    expect(screen.getByText("Press Shake: everyone changes direction and speed")).toBeTruthy();
    fireEvent.click(screen.getByText("Got it"));
    expect(screen.queryByText("Try this")).toBeNull();
    unmount();
    render(<AquariumView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText("Try this")).toBeNull();
    fireEvent.click(screen.getByText("Tips"));
    expect(screen.getByText("Try this")).toBeTruthy();
  });

  it("shakes the tank once per press, then reports that everyone changed course", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(SNAPSHOT)));
    const { container } = render(<AquariumView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const button = container.querySelector<HTMLButtonElement>('[data-action="aquarium-shake"]')!;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Shaking…");
    expect(container.querySelector('[data-component="AquariumTank"]')!.className).toContain("aq-tank-shake");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHAKE_MS);
    });
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[data-component="AquariumTank"]')!.className).not.toContain("aq-tank-shake");
    expect(screen.getByText("Everyone is swimming a new way.")).toBeTruthy();
    expect(container.querySelector('[data-hint="shake"]')!.getAttribute("data-done")).toBe("true");
  });

  it("marks a tap with a ripple and ticks off the tap tip", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(SNAPSHOT)));
    const { container } = render(<AquariumView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.pointerDown(container.querySelector("canvas")!, { clientX: 300, clientY: 200, button: 0, pointerType: "mouse" });
    expect(container.querySelector('[data-component="AquariumTapRipple"]')).not.toBeNull();
    expect(container.querySelector('[data-hint="tap"]')!.getAttribute("data-done")).toBe("true");
  });
});

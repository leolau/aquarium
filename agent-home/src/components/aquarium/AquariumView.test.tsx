// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SNAPSHOT_POLL_MS, type AquariumSnapshot } from "@/lib/aquarium/creatures";

import { AquariumView } from "./AquariumView";

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
});

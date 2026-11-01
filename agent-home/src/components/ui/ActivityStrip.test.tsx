// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActivityStrip,
  LONG_RUN_MS,
  fmtElapsed,
  resetActivityStripCache,
} from "@/components/ui/ActivityStrip";
import type { ActivityItem } from "@/types";

afterEach(() => {
  cleanup();
  resetActivityStripCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NOW = 1_700_000_000_000;

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    kind: "chat",
    id: "s1",
    name: "Plan the launch",
    started_at: NOW / 1000 - 75,
    href: "/chat?session=s1",
    profile: null,
    status: "running",
    ...over,
  };
}

function mockFeed(items: ActivityItem[] | null) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    items
      ? new Response(JSON.stringify({ items }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response("err", { status: 502 }),
  );
}

describe("fmtElapsed", () => {
  it("formats compactly by magnitude", () => {
    expect(fmtElapsed(42_000)).toBe("42s");
    expect(fmtElapsed(12 * 60_000)).toBe("12m");
    expect(fmtElapsed(65 * 60_000)).toBe("1h 05m");
    expect(fmtElapsed(51 * 3_600_000)).toBe("2d 3h");
    expect(fmtElapsed(-5)).toBe("0s");
  });
});

describe("ActivityStrip", () => {
  it("renders nothing at all when nothing is running", async () => {
    const fetchSpy = mockFeed([]);
    const { container } = render(<ActivityStrip />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    expect(container.innerHTML).toBe("");
  });

  it("shows one linked chip per running item with its kind and name", async () => {
    mockFeed([
      item(),
      item({ kind: "project_run", id: "r1", name: "Digest · run 3", href: "/projects/digest/runs/3", status: "waiting" }),
      item({ kind: "cron", id: "default:j1", name: "Backup", href: null }),
    ]);
    render(<ActivityStrip />);
    const chat = await screen.findByText("Plan the launch");
    expect(chat.closest("a")?.getAttribute("href")).toBe("/chat?session=s1");
    const run = screen.getByText("Digest · run 3").closest("a");
    expect(run?.getAttribute("href")).toBe("/projects/digest/runs/3");
    expect(run?.getAttribute("title")).toContain("waiting");
    // No page to open → a plain chip, not a dead link.
    expect(screen.getByText("Backup").closest("a")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("ticks the elapsed time locally without refetching", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const fetchSpy = mockFeed([item()]);
    render(<ActivityStrip />);
    await waitFor(() => expect(screen.getByTestId("activity-elapsed").textContent).toBe("1m"));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("activity-elapsed").textContent).toBe("2m");
    // 60s elapsed → four 15s polls, but the clock itself never fetched.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("turns a long run amber", async () => {
    mockFeed([item({ started_at: Date.now() / 1000 - LONG_RUN_MS / 1000 - 60 })]);
    render(<ActivityStrip />);
    const chip = (await screen.findByText("Plan the launch")).closest("a");
    expect(chip?.getAttribute("data-long")).toBe("true");
    expect(screen.getByTestId("activity-elapsed").className).toContain("warn");
  });

  it("keeps the last good rows, dimmed, when a read fails", async () => {
    const fetchSpy = mockFeed([item()]);
    const { container } = render(<ActivityStrip />);
    await screen.findByText("Plan the launch");
    fetchSpy.mockImplementation(async () => new Response("err", { status: 502 }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(container.querySelector("[data-stale]")).not.toBeNull(),
    );
    expect(screen.getByText("Plan the launch")).toBeTruthy();
  });

  it("shares one in-flight read between focus wakes", async () => {
    let release: (r: Response) => void = () => {};
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((r) => (release = r)),
    );
    render(<ActivityStrip />);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(fetchSpy).toHaveBeenCalledOnce();
    await act(async () => {
      release(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    });
  });

  it("reuses a fresh read across remounts instead of refetching", async () => {
    const fetchSpy = mockFeed([item()]);
    const first = render(<ActivityStrip />);
    await screen.findByText("Plan the launch");
    first.unmount();
    render(<ActivityStrip />);
    // Painted immediately from the module cache, no second request.
    expect(screen.getByText("Plan the launch")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("scrolls sideways with the arrows when the row overflows", async () => {
    mockFeed([item(), item({ id: "s2", name: "Second chat" })]);
    render(<ActivityStrip />);
    await screen.findByText("Second chat");
    const list = screen.getByRole("list");
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(list, "scrollWidth", { configurable: true, value: 600 });
    const scrollBy = vi.fn();
    (list as HTMLElement & { scrollBy: typeof scrollBy }).scrollBy = scrollBy;
    fireEvent.scroll(list);
    const right = screen.getByLabelText("Scroll activity right") as HTMLButtonElement;
    const left = screen.getByLabelText("Scroll activity left") as HTMLButtonElement;
    expect(right.disabled).toBe(false);
    expect(left.disabled).toBe(true);
    fireEvent.click(right);
    expect(scrollBy).toHaveBeenCalledWith({ left: 160, behavior: "smooth" });
    expect(list.className).toContain("snap-x");
  });
});

// @vitest-environment jsdom
/**
 * Task mode's running card: it names the card, its step and how long it has
 * run, streams the card's output (reasoning and tool calls) from the card
 * activity stream, follows new lines to the bottom, and folds away.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveTask } from "@/components/projects/live/liveState";

import { TaskLiveCard } from "./TaskLiveCard";

const TASK: LiveTask = {
  id: "t_find",
  title: "Find the options",
  profile: "research",
  startedAt: Math.floor(Date.now() / 1000) - 75,
  stepIndex: 1,
  stepTotal: 3,
};

function sse(frames: string): Response {
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

const FRAMES =
  'event: reasoning\ndata: {"seq":1,"at":1,"text":"Looking up HubSpot pricing"}\n\n' +
  'event: tool.start\ndata: {"seq":2,"at":2,"tool_id":"c1","name":"web_search"}\n\n' +
  'event: tool.complete\ndata: {"seq":3,"at":3,"tool_id":"c1","name":"web_search"}\n\n' +
  'event: tool.start\ndata: {"seq":4,"at":4,"tool_id":"c2","name":"read_file"}\n\n';

function stubStreams(activity = FRAMES) {
  const urls: string[] = [];
  const fn = vi.fn(async (input: string) => {
    urls.push(input);
    // Hold the activity stream after its frames, like a live worker.
    if (input.includes("/activity")) return urls.filter((u) => u.includes("/activity")).length === 1 ? sse(activity) : new Promise<Response>(() => undefined);
    return new Promise<Response>(() => undefined);
  });
  vi.stubGlobal("fetch", fn);
  return urls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TaskLiveCard", () => {
  it("names the running card, its step and elapsed time, and streams its output", async () => {
    const urls = stubStreams();
    render(<TaskLiveCard slug="crm" task={TASK} />);
    expect(screen.getByRole("heading", { name: "Find the options" })).toBeTruthy();
    expect(screen.getByText(/Now running · Step 1 of 3/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Looking up HubSpot pricing/)).toBeTruthy());
    const log = screen.getByRole("log", { name: "Card output" });
    await waitFor(() => expect(log.querySelectorAll("[data-tool]").length).toBe(2));
    expect(log.querySelector('[data-tool="done"]')?.textContent).toContain("web_search");
    expect(log.querySelector('[data-tool="running"]')?.textContent).toContain("read_file");
    const meta = document.querySelector('[data-component="TaskLiveMeta"]')?.textContent ?? "";
    expect(meta).toContain("worker on research");
    expect(meta).toMatch(/running 1m 1\ds/);
    expect(urls).toContain("/api/projects/crm/cards/t_find/activity?after=0");
    expect(urls).toContain("/api/projects/crm/cards/t_find/stream");
  });

  it("follows new output to the bottom", async () => {
    stubStreams();
    const tops: number[] = [];
    const proto = HTMLElement.prototype;
    const height = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const top = Object.getOwnPropertyDescriptor(proto, "scrollTop");
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(proto, "scrollTop", {
      configurable: true,
      get: () => tops[tops.length - 1] ?? 0,
      set: (v: number) => tops.push(v),
    });
    try {
      render(<TaskLiveCard slug="crm" task={TASK} />);
      await waitFor(() => expect(screen.getByText(/Looking up HubSpot pricing/)).toBeTruthy());
      expect(tops[tops.length - 1]).toBe(500);
    } finally {
      if (height) Object.defineProperty(proto, "scrollHeight", height);
      else delete (proto as unknown as Record<string, unknown>).scrollHeight;
      if (top) Object.defineProperty(proto, "scrollTop", top);
      else delete (proto as unknown as Record<string, unknown>).scrollTop;
    }
  });

  it("folds the output away and back", async () => {
    stubStreams();
    render(<TaskLiveCard slug="crm" task={TASK} />);
    const toggle = screen.getByRole("button", { name: "Hide output" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.getByRole("button", { name: "Show output" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(screen.getByRole("log", { name: "Card output" })).toBeTruthy();
  });

  it("says it is waiting before the worker's first update", () => {
    stubStreams("");
    render(<TaskLiveCard slug="crm" task={TASK} />);
    expect(screen.getByText("Waiting for the agent's first update…")).toBeTruthy();
  });
});

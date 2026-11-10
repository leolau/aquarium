// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (cb: () => void) => {
    window.addEventListener("popstate", cb);
    window.addEventListener("test:navigate", cb);
    return () => {
      window.removeEventListener("popstate", cb);
      window.removeEventListener("test:navigate", cb);
    };
  };
  return {
    useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    usePathname: () => "/",
    useSearchParams: () =>
      new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
  };
});
vi.mock("@/lib/chat/session-list-fetch", () => ({
  fetchSessionList: async (url: string) => {
    const res = await fetch(url);
    return res.ok ? res.json() : null;
  },
}));
vi.mock("@/components/ui/useStatusSummary", () => ({ useStatusSummary: () => ({}) }));
vi.mock("@/components/ui/useActivityRunning", () => ({ useActivityRunning: () => ({}) }));
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
vi.mock("./topbar", () => ({
  TopBarView: ({ onToggleSidebar }: { onToggleSidebar: () => void }) => (
    <button type="button" onClick={onToggleSidebar}>
      Toggle chats
    </button>
  ),
}));
vi.mock("./work", () => ({ LandingWorkPanel: () => <div data-component="LandingWorkPanel" /> }));

import { fakeFetch, json, userChatSessions as sessions } from "./chats/__tests__/fixtures";
import { LandingClient } from "./LandingClient";

const profiles = [{ name: "default", is_default: true }] as never;

const transcripts: Record<string, { role: string; content: string }[]> = {
  "s-q3": [
    { role: "user", content: "Draft the Q3 plan" },
    { role: "assistant", content: "Here is the Q3 plan outline." },
  ],
  "s-refactor": [{ role: "assistant", content: "Webhooks now retry with backoff." }],
  "s-untitled": [
    { role: "user", content: "can you check why the nightly sync failed" },
    { role: "assistant", content: "The nightly sync failed on a timeout." },
  ],
};

function install() {
  const f = vi.fn(
    fakeFetch({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/messages": (_i, url) =>
        json({ messages: transcripts[url.searchParams.get("sessionId") ?? ""] ?? [] }),
      "GET /api/chat/active": () => json({ runId: null }),
      "GET /api/chat/sessions/search": () =>
        json({
          results: [
            { session_id: "s-untitled", role: "assistant", snippet: "The >>>nightly<<< sync failed", title: null },
          ],
        }),
    }),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

const realPush = window.history.pushState.bind(window.history);

function renderLanding() {
  return render(<LandingClient profiles={profiles} currentProfile="default" />);
}

const sidebar = () => within(document.querySelector<HTMLElement>('[data-component="landing-sidebar"]')!);
const inline = () => document.querySelector('[data-component="LandingChat"]');
const composer = () => document.querySelector('[data-component="LandingComposer"]');

describe("LandingClient inline chat", () => {
  beforeEach(() => {
    push.mockReset();
    install();
    realPush(null, "", "/");
    window.history.pushState = (...args: Parameters<History["pushState"]>) => {
      realPush(...args);
      window.dispatchEvent(new Event("test:navigate"));
    };
    window.matchMedia ??= (() => ({ matches: false })) as never;
  });
  afterEach(() => {
    cleanup();
    window.history.pushState = realPush;
    vi.unstubAllGlobals();
  });

  it("opens a sidebar chat in the centre column without leaving the page", async () => {
    renderLanding();
    expect(composer()).toBeTruthy();
    const link = await sidebar().findByRole("link", { name: "Q3 planning notes" });
    const before = window.history.length;
    fireEvent.click(link);

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?chat=s-q3");
    expect(window.history.length).toBe(before + 1);
    expect(push).not.toHaveBeenCalled();
    expect(composer()).toBeNull();
    expect(await screen.findByText("Here is the Q3 plan outline.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Q3 planning notes" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open full page/ }).getAttribute("href")).toBe(
      "/chat?session=s-q3",
    );
    expect(link.closest("li")?.getAttribute("data-state")).toBe("active");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/chat/messages?sessionId=s-q3"),
      expect.anything(),
    );
  });

  it("lines the inline composer up with the transcript card", async () => {
    renderLanding();
    fireEvent.click(await sidebar().findByRole("link", { name: "Q3 planning notes" }));
    await screen.findByText("Here is the Q3 plan outline.");
    const inline = document.querySelector<HTMLElement>(
      '[data-component="LandingChat"] [data-component="Composer"]',
    );
    expect(inline).toBeTruthy();
    expect(inline!.style.marginLeft).toBe("");
  });

  it("adds one history entry for a double press", async () => {
    renderLanding();
    const link = await sidebar().findByRole("link", { name: "Q3 planning notes" });
    const before = window.history.length;
    fireEvent.click(link);
    fireEvent.click(link);
    expect(window.history.length).toBe(before + 1);
  });

  it("leaves modified clicks to the full chat page link", async () => {
    renderLanding();
    const link = await sidebar().findByRole("link", { name: "Q3 planning notes" });
    expect(link.getAttribute("href")).toBe("/chat?session=s-q3");
    fireEvent.click(link, { metaKey: true });
    expect(window.location.search).toBe("");
    expect(composer()).toBeTruthy();
  });

  it("Back returns to the composer", async () => {
    renderLanding();
    fireEvent.click(await sidebar().findByRole("link", { name: "Q3 planning notes" }));
    await screen.findByText("Here is the Q3 plan outline.");

    fireEvent.click(screen.getByRole("link", { name: "Back to Home" }));
    expect(window.location.search).toBe("");
    expect(inline()).toBeNull();
    expect(composer()).toBeTruthy();
  });

  it("renaming the open chat in the sidebar updates the inline heading", async () => {
    const base = vi.mocked(fetch);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/api/chat/sessions/rename")
          ? Promise.resolve(json({ ok: true, title: JSON.parse(String(init?.body)).title }))
          : base(input, init),
      ),
    );
    renderLanding();
    fireEvent.click(await sidebar().findByRole("link", { name: "Q3 planning notes" }));
    await screen.findByRole("heading", { level: 2, name: "Q3 planning notes" });

    fireEvent.click(sidebar().getByRole("button", { name: "Rename “Q3 planning notes”" }));
    const input = sidebar().getByLabelText("Chat title");
    fireEvent.change(input, { target: { value: "Q3 plan v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 2, name: "Q3 plan v2" })).toBeTruthy();
  });

  it("browser Back returns to the composer", async () => {
    renderLanding();
    fireEvent.click(await sidebar().findByRole("link", { name: "Q3 planning notes" }));
    await screen.findByText("Here is the Q3 plan outline.");

    act(() => window.history.back());
    await waitFor(() => expect(composer()).toBeTruthy());
    expect(inline()).toBeNull();
  });

  it("opens the chat in ?chat= on load", async () => {
    window.history.replaceState(null, "", "/?chat=s-refactor");
    renderLanding();
    expect(composer()).toBeNull();
    expect(await screen.findByText("Webhooks now retry with backoff.")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Refactor billing webhooks" }),
    ).toBeTruthy();
  });

  it("opens a message-search hit with the match highlighted", async () => {
    renderLanding();
    fireEvent.change(sidebar().getByRole("searchbox"), { target: { value: "nightly" } });
    await waitFor(
      () => expect(document.querySelector('[data-action="open-message-hit"]')).toBeTruthy(),
      { timeout: 2000 },
    );
    fireEvent.click(document.querySelector('[data-action="open-message-hit"]')!);

    expect(window.location.search).toBe("?chat=s-untitled");
    await screen.findByText(/on a timeout/);
    const marks = [...document.querySelectorAll('[data-component="LandingChat"] mark')];
    expect(marks.map((m) => m.textContent?.toLowerCase())).toContain("nightly");
    expect(screen.getByText("Highlighting “nightly”")).toBeTruthy();
  });

  it("a chat tapped in the phone drawer closes the drawer and opens inline", async () => {
    renderLanding();
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    const drawer = await screen.findByRole("dialog");
    fireEvent.click(await within(drawer).findByRole("link", { name: "Debug flaky e2e test" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("?chat=s-flaky");
    expect(inline()).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});

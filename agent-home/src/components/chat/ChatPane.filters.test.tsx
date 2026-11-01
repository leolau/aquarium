// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_FILTERS_OPEN_STORAGE_KEY } from "@/components/chat/ChatFiltersPanel";
import { ChatPane } from "@/components/chat/ChatPane";
import type { ChatMessage, SessionSummary } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const TAGS = [
  { id: "t1", name: "bug", color: "red" },
  { id: "t2", name: "work", color: "blue" },
];

const SESSIONS: SessionSummary[] = [
  {
    id: "s1",
    source: "agent-home",
    title: "Trip planning",
    preview: null,
    message_count: 2,
    started_at: 1,
    last_active: 1,
    ended_at: null,
  },
];

const MESSAGES: ChatMessage[] = [
  { id: 1, role: "user", content: "hello there" },
  { id: 2, role: "assistant", content: "general kenobi" },
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/chat/sessions/tags")
        ? { tags: TAGS }
        : url.includes("/api/chat/active")
          ? { runId: null }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function renderPane() {
  return render(
    <ChatPane
      initialSessions={SESSIONS}
      initialSessionId="s1"
      initialMessages={MESSAGES}
      storageEnabled={false}
      profiles={[
        { name: "default", is_default: true },
        { name: "work", is_default: false },
      ] as never}
      profile="default"
    />,
  );
}

const toggle = () => screen.getByRole("button", { name: /Filters & search/ });
const panel = () => document.getElementById(toggle().getAttribute("aria-controls")!)!;

describe("ChatPane filters & search panel", () => {
  it("is collapsed by default with the profile and session strip still visible", () => {
    renderPane();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel().hidden).toBe(true);
    expect(screen.getByTestId("chat-filters-profile").textContent).toContain("default");
    expect(screen.getByText("Trip planning")).toBeTruthy();
  });

  it("remembers open/closed per browser", () => {
    const first = renderPane();
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(CHAT_FILTERS_OPEN_STORAGE_KEY)).toBe("1");
    first.unmount();
    renderPane();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hidden).toBe(false);
  });

  it("badges active filters, and collapsing keeps filters and searches", async () => {
    renderPane();
    fireEvent.click(toggle());
    fireEvent.click(await screen.findByRole("button", { name: "bug" }));
    fireEvent.click(screen.getByRole("button", { name: "work" }));
    fireEvent.click(screen.getByRole("button", { name: /In conversation/ }));
    const input = screen.getByPlaceholderText("Search in conversation…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });

    fireEvent.click(toggle());
    expect(panel().hidden).toBe(true);
    expect(screen.getByTestId("chat-filters-badge").textContent).toBe("2 filters");
    expect(screen.getByTestId("chat-filters-search")).toBeTruthy();
    // Still mounted, so nothing was reset.
    expect(
      (screen.getByPlaceholderText("Search in conversation…") as HTMLInputElement).value,
    ).toBe("hello");
    expect(document.querySelector("mark")?.textContent).toBe("hello");

    fireEvent.click(toggle());
    expect(screen.getByTestId("chat-filters-badge").textContent).toBe("2 filters");
    // The AND/OR switch only renders while tag filters are active.
    expect(screen.getByRole("button", { name: "OR" })).toBeTruthy();
  });

  it("/ and Ctrl+K expand the panel and focus the all-sessions search", async () => {
    renderPane();
    act(() => {
      fireEvent.keyDown(document.body, { key: "/" });
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const search = screen.getByPlaceholderText("Search all sessions…");
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.click(toggle());
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("ignores / typed into the composer", () => {
    renderPane();
    const composer = screen.getByPlaceholderText(/Message your agent/);
    fireEvent.keyDown(composer, { key: "/" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});

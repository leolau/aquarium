// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_FILTERS_OPEN_STORAGE_KEY } from "@/components/chat/ChatFiltersPanel";
import { ChatPane } from "@/components/chat/ChatPane";
import type { ChatMessage, SessionSummary } from "@/types";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
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

const HIT = {
  session_id: "s2",
  snippet: "hello >>>kenobi<<< there",
  role: "assistant",
  title: "Star wars",
};

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
        : url.includes("/api/chat/sessions/search")
          ? { results: [HIT] }
          : url.includes("/api/chat/messages?sessionId=s2")
            ? { messages: [{ id: 3, role: "user", content: "hello kenobi" }] }
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
      profile="default"
    />,
  );
}

const toggle = () => screen.getByRole("button", { name: /Filters & search/ });
const sidebarSearch = () =>
  document.getElementById("landing-sidebar-chat-search") as HTMLInputElement;
const fetchedUrls = () =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));
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

  it("/ and Ctrl+K focus the chats sidebar's all-sessions search", () => {
    renderPane();
    const search = sidebarSearch();
    act(() => {
      fireEvent.keyDown(document.body, { key: "/" });
    });
    expect(document.activeElement).toBe(search);
    // The old search strip is gone; the panel stays as the user left it.
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /All sessions/ })).toBeNull();

    search.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    });
    expect(document.activeElement).toBe(search);
  });

  it("opens the Chats drawer with its search focused when the sidebar is hidden", async () => {
    renderPane();
    // Below lg the sidebar is display:none, so focusing its input does nothing.
    vi.spyOn(sidebarSearch(), "focus").mockImplementation(() => {});
    act(() => {
      fireEvent.keyDown(document.body, { key: "/" });
    });
    const drawer = await screen.findByRole("dialog", { name: "Chats" });
    expect(document.activeElement).toBe(within(drawer).getByLabelText("Search chats"));
  });

  it("ignores / typed into the composer", () => {
    renderPane();
    const composer = screen.getByPlaceholderText(/Message your agent/);
    composer.focus();
    fireEvent.keyDown(composer, { key: "/" });
    expect(document.activeElement).toBe(composer);
    expect(screen.queryByRole("dialog", { name: "Chats" })).toBeNull();
  });

  it("the sidebar search also finds messages in every chat and opens the hit highlighted", async () => {
    renderPane();
    fireEvent.change(sidebarSearch(), { target: { value: "kenobi" } });
    const hit = await screen.findByRole("button", { name: /Star wars/ });
    expect(fetchedUrls().some((u) => u.includes("/api/chat/sessions/search?q=kenobi"))).toBe(true);
    expect(within(hit).getByText("kenobi").tagName).toBe("MARK");

    // Another chat: navigate like a sidebar row, so the title and address follow.
    fireEvent.click(hit);
    expect(push).toHaveBeenCalledWith("/chat?session=s2&find=kenobi");
  });

  it("opens with `?find=` highlighted and drops it from the address", () => {
    push.mockClear();
    window.history.replaceState(null, "", "/chat?session=s1&find=hello");
    render(
      <ChatPane
        initialSessions={SESSIONS}
        initialSessionId="s1"
        initialMessages={MESSAGES}
        storageEnabled={false}
        profile="default"
        initialHighlight="hello"
      />,
    );
    expect(document.querySelector('[data-component="MessageBubble"] mark')?.textContent).toBe("hello");
    expect(window.location.search).toBe("?session=s1");
    expect(push).not.toHaveBeenCalled();
  });
});

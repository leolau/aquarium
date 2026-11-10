// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/" }));
// Bypass the shared 2 s session-list cache so every test sees its own fetch.
vi.mock("@/lib/chat/session-list-fetch", () => ({
  fetchSessionList: async (url: string) => {
    const res = await fetch(url);
    return res.ok ? res.json() : null;
  },
}));

import { ChatsDrawer } from "../ChatsDrawer";
import { ChatsSidebar } from "../ChatsSidebar";
import { notifySessionsChanged } from "@/lib/chat/sessions-changed";

import { NOW, fakeFetch, json, sessions, userChatSessions, withoutPins } from "./fixtures";

const profiles = [
  { name: "default", is_default: true },
  { name: "work", is_default: false },
] as never;

const suggestions = {
  items: [
    { session_id: "s-flaky", title: "Debug flaky e2e test", reason: "stopped mid-way", last_active: 1 },
    { session_id: "s-onboarding", title: "Onboarding email sequence", reason: "stopped mid-way", last_active: 1 },
  ],
  generated_at: 1,
};

function install(routes: Parameters<typeof fakeFetch>[0]) {
  const f = vi.fn(fakeFetch(routes));
  vi.stubGlobal("fetch", f);
  return f;
}

function bodyOf(f: ReturnType<typeof install>, key: string) {
  const call = f.mock.calls.find(
    ([u, i]) => `${(i?.method ?? "GET").toUpperCase()} ${new URL(String(u), "http://x").pathname}` === key,
  );
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

function rowNames(section: string) {
  const el = screen.getByRole("region", { name: section });
  return within(el)
    .getAllByRole("link")
    .map((a) => a.textContent);
}

describe("ChatsSidebar", () => {
  beforeEach(() => push.mockReset());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists pinned and recent chats newest first with a live dot", async () => {
    install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/pin-suggestions": () => json({ items: [], generated_at: 1 }),
    });
    render(<ChatsSidebar profiles={profiles} />);
    await screen.findByRole("region", { name: "Pinned chats" });
    expect(rowNames("Pinned chats")).toEqual(["Refactor billing webhooks", "Q3 planning notes"]);
    expect(rowNames("Recent chats")).toEqual([
      "Pricing page copy review",
      "can you check why the nightly sync failed",
      "Debug flaky e2e test",
      "Onboarding email sequence",
    ]);
    expect(screen.queryByText("Archived thing")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Working now" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /All chats/ }).getAttribute("href")).toBe("/chat");
  });

  it("filters by search", async () => {
    install({ "GET /api/chat/sessions": () => json({ sessions }) });
    render(<ChatsSidebar profiles={profiles} />);
    await screen.findByText("Q3 planning notes");
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "nightly" } });
    expect(screen.getByText("can you check why the nightly sync failed")).toBeTruthy();
    expect(screen.queryByText("Q3 planning notes")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "zzz" } });
    expect(screen.getByText(/No chats match/)).toBeTruthy();
  });

  it("pins both suggested chats", async () => {
    const f = install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/pin-suggestions": () => json(suggestions),
      "POST /api/chat/sessions/pin": (init) => {
        const b = JSON.parse(String(init?.body));
        return json({ ok: true, session_id: b.sessionId, pinned_at: 999 });
      },
    });
    render(<ChatsSidebar profiles={profiles} />);
    fireEvent.click(await screen.findByRole("button", { name: /Pin both/ }));
    await waitFor(() => expect(screen.queryByText("2 unfinished chats worth pinning")).toBeNull());
    const pins = f.mock.calls.filter(([u]) => String(u).includes("/sessions/pin"));
    expect(pins.map(([, i]) => JSON.parse(String(i?.body)).sessionId)).toEqual(["s-flaky", "s-onboarding"]);
    expect(new Headers(pins[0][1]?.headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("'Not now' hides the suggestion and records the dismissal", async () => {
    const f = install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/pin-suggestions": () => json(suggestions),
      "POST /api/chat/pin-suggestions/dismiss": () => json({ ok: true }),
    });
    render(<ChatsSidebar profiles={profiles} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("2 unfinished chats worth pinning")).toBeNull();
    await waitFor(() =>
      expect(bodyOf(f, "POST /api/chat/pin-suggestions/dismiss")).toEqual({
        sessionIds: ["s-flaky", "s-onboarding"],
      }),
    );
  });

  it("offers Undo after pinning a chat, and Undo unpins it", async () => {
    const f = install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/pin-suggestions": () => json({ items: [], generated_at: 1 }),
      "POST /api/chat/sessions/pin": (init) => {
        const b = JSON.parse(String(init?.body));
        return json({ ok: true, session_id: b.sessionId, pinned_at: b.pinned ? 999 : null });
      },
    });
    render(<ChatsSidebar profiles={profiles} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pin “Debug flaky e2e test”" }));
    expect(await screen.findByText("Chat pinned")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => {
      const pins = f.mock.calls.filter(([u]) => String(u).includes("/sessions/pin"));
      expect(pins.map(([, i]) => JSON.parse(String(i?.body)).pinned)).toEqual([true, false]);
    });
  });

  it("hides all pin UI when pins aren't deployed (no pinned_at, routes 404)", async () => {
    const legacy = withoutPins(sessions);
    install({ "GET /api/chat/sessions": () => json({ sessions: legacy }) });
    render(<ChatsSidebar profiles={profiles} />);
    await screen.findByRole("region", { name: "Recent chats" });
    expect(screen.queryByRole("region", { name: "Pinned chats" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Pin|Unpin) / })).toBeNull();
    expect(rowNames("Recent chats")[0]).toBe("Pricing page copy review");
  });

  it("hides pin UI after a pin write 404s", async () => {
    install({
      "GET /api/chat/sessions": () => json({ sessions }),
    });
    render(<ChatsSidebar profiles={profiles} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pin “Debug flaky e2e test”" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pinned chats" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renames a chat through the rename route", async () => {
    let list = sessions;
    const f = install({
      "GET /api/chat/sessions": () => json({ sessions: list }),
      "PATCH /api/chat/sessions/rename": (init) => {
        const b = JSON.parse(String(init?.body));
        list = list.map((s) => (s.id === b.sessionId ? { ...s, title: b.title } : s));
        return json({ ok: true, title: b.title });
      },
    });
    render(<ChatsSidebar profiles={profiles} profile="work" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename “can you check why the nightly sync failed”" }));
    const input = screen.getByLabelText("Chat title");
    fireEvent.change(input, { target: { value: "Nightly sync failure" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Nightly sync failure")).toBeTruthy();
    expect(bodyOf(f, "PATCH /api/chat/sessions/rename")).toEqual({
      sessionId: "s-untitled",
      title: "Nightly sync failure",
      profile: "work",
    });
  });

  it("archives a chat once, hides it, and Undo restores it", async () => {
    let list = sessions;
    const f = install({
      "GET /api/chat/sessions": () => json({ sessions: list }),
      "GET /api/chat/pin-suggestions": () => json({ items: [], generated_at: 1 }),
      "PATCH /api/chat/sessions/archive": async (init) => {
        const b = JSON.parse(String(init?.body));
        list = list.map((s) => (s.id === b.sessionId ? { ...s, archived: b.archived } : s));
        return json({ ok: true });
      },
    });
    render(<ChatsSidebar profiles={profiles} profile="work" />);
    const btn = await screen.findByRole("button", { name: "Archive “Debug flaky e2e test”" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(rowNames("Recent chats")).not.toContain("Debug flaky e2e test"));
    expect(await screen.findByText("Chat archived")).toBeTruthy();
    const archives = () => f.mock.calls.filter(([u]) => String(u).includes("/sessions/archive"));
    expect(archives()).toHaveLength(1);
    expect(bodyOf(f, "PATCH /api/chat/sessions/archive")).toEqual({
      sessionId: "s-flaky",
      archived: true,
      profile: "work",
    });
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(rowNames("Recent chats")).toContain("Debug flaky e2e test"));
    expect(archives().map(([, i]) => JSON.parse(String(i?.body)).archived)).toEqual([true, false]);
  });

  it("puts an archived chat back and explains when the archive fails", async () => {
    install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/pin-suggestions": () => json({ items: [], generated_at: 1 }),
      "PATCH /api/chat/sessions/archive": () => json({ error: "api_error", detail: "boom" }, 500),
    });
    render(<ChatsSidebar profiles={profiles} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archive “Debug flaky e2e test”" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(rowNames("Recent chats")).toContain("Debug flaky e2e test");
    expect(screen.queryByText("Chat archived")).toBeNull();
  });

  it("lists a chat started elsewhere on the page under Recent at once", async () => {
    let list = sessions;
    install({
      "GET /api/chat/sessions": () => json({ sessions: list }),
      "GET /api/chat/pin-suggestions": () => json({ items: [], generated_at: 1 }),
    });
    render(<ChatsSidebar profiles={profiles} profile="work" />);
    await screen.findByRole("region", { name: "Recent chats" });
    act(() => notifySessionsChanged({ profile: "work", session: { id: "s-new", preview: "draft the Q4 plan" } }));
    expect(rowNames("Recent chats")[0]).toBe("draft the Q4 plan");
    // The server has not listed it yet: the forced re-read must not drop it.
    await new Promise((r) => setTimeout(r, 20));
    expect(rowNames("Recent chats")[0]).toBe("draft the Q4 plan");
    // Once the server lists it (with its title), it shows once.
    list = [{ ...sessions[0], id: "s-new", title: "Q4 plan", pinned_at: null, last_active: 9e9 }, ...sessions];
    act(() => notifySessionsChanged({ profile: "work" }));
    await waitFor(() => expect(rowNames("Recent chats")[0]).toBe("Q4 plan"));
    expect(rowNames("Recent chats").filter((n) => n === "draft the Q4 plan")).toHaveLength(0);
  });

  it("ignores chats started in another profile", async () => {
    install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/pin-suggestions": () => json({ items: [], generated_at: 1 }),
    });
    render(<ChatsSidebar profiles={profiles} profile="work" />);
    await screen.findByRole("region", { name: "Recent chats" });
    act(() => notifySessionsChanged({ profile: "default", session: { id: "s-other", preview: "other profile" } }));
    expect(screen.queryByText("other profile")).toBeNull();
  });

  it("starts a new chat in the default profile and opens it", async () => {
    const f = install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "POST /api/chat/new": () => json({ session_id: "s-new" }),
    });
    render(<ChatsSidebar profiles={profiles} />);
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/chat?session=s-new"));
    expect(bodyOf(f, "POST /api/chat/new")).toEqual({});
  });

  it("switches profile before starting a chat in another one", async () => {
    const f = install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "POST /api/session/profile": () => json({ ok: true }),
      "POST /api/chat/new": () => json({ session_id: "s-work" }),
    });
    render(<ChatsSidebar profiles={profiles} />);
    fireEvent.change(screen.getByLabelText("Profile for the new chat"), { target: { value: "work" } });
    expect(screen.getByText("Starting in work")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const order = f.mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${new URL(String(u), "http://x").pathname}`);
    expect(order.indexOf("POST /api/chat/new")).toBeGreaterThan(-1);
    expect(bodyOf(f, "POST /api/chat/new")).toEqual({ profile: "work" });
  });

  it("shows the empty-state illustration with no chats", async () => {
    install({ "GET /api/chat/sessions": () => json({ sessions: [] }) });
    const { container } = render(<ChatsSidebar profiles={profiles} />);
    expect(await screen.findByText("No chats yet")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/brand/illustrations/empty-sessions@2x.png",
    );
  });

  it("offers a retry when the list cannot be read", async () => {
    install({ "GET /api/chat/sessions": () => json({ error: "down" }, 502) });
    render(<ChatsSidebar profiles={profiles} />);
    expect(await screen.findByText(/couldn't be loaded/)).toBeTruthy();
  });
});

describe("ChatsDrawer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing while closed and closes on Esc, ✕ and navigation", async () => {
    install({ "GET /api/chat/sessions": () => json({ sessions }) });
    const onClose = vi.fn();
    const { rerender } = render(<ChatsDrawer open={false} onClose={onClose} profiles={profiles} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    rerender(<ChatsDrawer open onClose={onClose} profiles={profiles} />);
    expect(screen.getByRole("dialog", { name: "Chats" })).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close chats" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(await screen.findByText("Q3 planning notes"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("pin suggestions review", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-reads suggestions while the background review is pending", async () => {
    let calls = 0;
    install({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/chat/pin-suggestions": () =>
        json(++calls === 1 ? { items: [], generated_at: null, pending: true } : suggestions),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<ChatsSidebar profiles={profiles} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    vi.useRealTimers();
    expect(await screen.findByText("2 unfinished chats worth pinning")).toBeTruthy();
    expect(calls).toBe(2);
  });
});

describe("ChatsSidebar on the landing page", () => {
  const userChats = userChatSessions;
  const others = [
    { ...userChats[4], id: "s-cron", source: "cron", title: "Nightly digest", last_active: NOW / 1000 },
    { ...userChats[4], id: "s-run", source: "projects:acme:run-3", title: "Project run", last_active: NOW / 1000 },
    { ...userChats[4], id: "s-tg", source: "telegram", title: "Telegram triage", pinned_at: NOW / 1000 },
    {
      ...userChats[4],
      id: "s-kanban",
      source: "agent_home",
      title: "Kanban card",
      cwd: "/home/a/.hermes/kanban/workspaces/t_1",
      last_active: NOW / 1000,
    },
    { ...userChats[4], id: "s-report", source: "agent_home", title: "Daily report", preview: "", last_active: NOW / 1000 },
  ];

  beforeEach(() => push.mockReset());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks the server for Aquarium chats only and hides everything else, pins included", async () => {
    const f = install({ "GET /api/chat/sessions": () => json({ sessions: [...userChats, ...others] }) });
    render(<ChatsSidebar profiles={profiles} userChatsOnly />);
    await screen.findByRole("region", { name: "Pinned chats" });
    const url = new URL(String(f.mock.calls[0][0]), "http://x");
    expect(url.searchParams.get("source")).toBe("agent_home");
    expect(rowNames("Pinned chats")).toEqual(["Refactor billing webhooks", "Q3 planning notes"]);
    for (const title of ["Nightly digest", "Project run", "Telegram triage", "Kanban card", "Daily report"]) {
      expect(screen.queryByText(title)).toBeNull();
    }
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "a" } });
    expect(screen.queryByText("Telegram triage")).toBeNull();
    expect(screen.queryByText("Daily report")).toBeNull();
    expect(f.mock.calls.some(([, i]) => (i?.method ?? "GET") !== "GET")).toBe(false);
  });

  it("drops message hits from chats the sidebar hides", async () => {
    install({ "GET /api/chat/sessions": () => json({ sessions: [...userChats, ...others] }) });
    const messageSearch = vi.fn(async () => [
      { session_id: "s-flaky", snippet: "flaky", role: "user", title: "Debug flaky e2e test", source: "agent_home" },
      { session_id: "s-tg", snippet: "flaky", role: "user", title: "Telegram triage", source: "telegram" },
      { session_id: "s-report", snippet: "flaky", role: "assistant", title: "Daily report", source: "agent_home" },
    ]);
    render(
      <ChatsSidebar profiles={profiles} userChatsOnly messageSearch={messageSearch} onOpenMessageHit={vi.fn()} />,
    );
    await screen.findByText("Q3 planning notes");
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "flaky" } });
    const hits = await screen.findByRole("region", { name: /messages/i });
    await waitFor(() => expect(within(hits).getAllByRole("button")).toHaveLength(1));
    expect(within(hits).getByText("Debug flaky e2e test")).toBeTruthy();
    expect(within(hits).queryByText("Telegram triage")).toBeNull();
    expect(within(hits).queryByText("Daily report")).toBeNull();
  });

  it("still lists a chat started on the landing page at the top of Recent right away", async () => {
    install({ "GET /api/chat/sessions": () => json({ sessions: userChats }) });
    render(<ChatsSidebar profiles={profiles} profile="default" userChatsOnly highlightLatest />);
    await screen.findByText("Q3 planning notes");
    act(() => notifySessionsChanged({ profile: "default", session: { id: "s-new", preview: "draft the Q4 plan" } }));
    expect(rowNames("Recent chats")[0]).toMatch(/^draft the Q4 plan/);
    await waitFor(() => expect(rowNames("Recent chats")[0]).toMatch(/^draft the Q4 plan/));
  });

  it("marks the latest chat to continue while no chat is open", async () => {
    install({ "GET /api/chat/sessions": () => json({ sessions: userChats }) });
    const onOpenChat = vi.fn();
    const { rerender } = render(<ChatsSidebar profiles={profiles} highlightLatest onOpenChat={onOpenChat} />);
    await screen.findByText("Q3 planning notes");
    const rows = document.querySelectorAll("[data-state='resume']");
    expect(rows).toHaveLength(1);
    const link = within(rows[0] as HTMLElement).getByRole("link");
    expect(link.textContent).toBe("Pricing page copy review — continue your last chat");
    expect(within(rows[0] as HTMLElement).getByText("Continue")).toBeTruthy();
    fireEvent.click(link);
    expect(onOpenChat).toHaveBeenCalledWith(expect.objectContaining({ id: "s-pricing" }));

    rerender(
      <ChatsSidebar profiles={profiles} highlightLatest onOpenChat={onOpenChat} activeSessionId="s-pricing" />,
    );
    expect(document.querySelector("[data-state='resume']")).toBeNull();
    expect(screen.queryByText("Continue")).toBeNull();
    expect(document.querySelector("[data-state='active']")).toBeTruthy();
  });

  it("does not mark a chat without highlightLatest or while searching", async () => {
    install({ "GET /api/chat/sessions": () => json({ sessions: userChats }) });
    const { rerender } = render(<ChatsSidebar profiles={profiles} />);
    await screen.findByText("Q3 planning notes");
    expect(document.querySelector("[data-state='resume']")).toBeNull();
    rerender(<ChatsSidebar profiles={profiles} highlightLatest />);
    expect(document.querySelector("[data-state='resume']")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "pricing" } });
    expect(document.querySelector("[data-state='resume']")).toBeNull();
  });
});

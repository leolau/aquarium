// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// Bypass the shared 2 s session-list cache so every test sees its own fetch.
vi.mock("@/lib/chat/session-list-fetch", () => ({
  fetchSessionList: async (url: string) => {
    const res = await fetch(url);
    return res.ok ? res.json() : null;
  },
}));

import { LandingComposer } from "./LandingComposer";
import { chatHref } from "./chats/chatsApi";
import { chatHandOffUrl, greetingFor } from "./startChat";
import { fakeFetch, json, userChatSessions } from "./chats/__tests__/fixtures";

const profiles = [
  { name: "default", is_default: true },
  { name: "work", is_default: false },
] as never;

describe("LandingComposer", () => {
  beforeEach(() => {
    push.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hands the message to a fresh chat on Enter", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "  hello there " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(push).toHaveBeenCalledWith(chatHandOffUrl("hello there")));
    // The Continue chip's session-list read is fine; no profile switch POST.
    expect(fetch).not.toHaveBeenCalledWith("/api/session/profile", expect.anything());
  });

  it("switches profile before starting the chat in another profile", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    fireEvent.change(screen.getByLabelText("Profile for the new chat"), { target: { value: "work" } });
    expect(screen.getByText("Starting in work")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith("/api/session/profile", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the user on the page when the profile switch is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    fireEvent.change(screen.getByLabelText("Profile for the new chat"), { target: { value: "work" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("does nothing for an empty message and fills the box from a suggestion", () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" needsYouCount={3} />);
    expect((screen.getByRole("button", { name: "Start chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("landing-subline").textContent).toBe("3 things need you");
    fireEvent.click(screen.getByText("What needs my attention?"));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("What needs my attention?");
  });

  it("offers Continue for the last chat and opens it in place", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(fakeFetch({ "GET /api/chat/sessions": () => json({ sessions: userChatSessions }) })),
    );
    const onOpenChat = vi.fn();
    render(<LandingComposer profiles={profiles} currentProfile="default" onOpenChat={onOpenChat} />);
    const chip = await screen.findByRole("button", { name: /Pricing page copy review/ });
    expect(chip.textContent).toContain("Continue");
    fireEvent.click(chip);
    expect(onOpenChat).toHaveBeenCalledWith(expect.objectContaining({ id: "s-pricing" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("navigates the Continue chip to the chat page without an inline opener", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(fakeFetch({ "GET /api/chat/sessions": () => json({ sessions: userChatSessions }) })),
    );
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    fireEvent.click(await screen.findByRole("button", { name: /Pricing page copy review/ }));
    expect(push).toHaveBeenCalledWith(chatHref("s-pricing", "default"));
  });

  it("hides the Continue chip when there is no chat to resume", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(fakeFetch({ "GET /api/chat/sessions": () => json({ sessions: [] }) })),
    );
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("Continue")).toBeNull();
  });

  it("builds the hand-off url and greets by hour", () => {
    expect(chatHandOffUrl("a b")).toBe("/chat?new=1&autosend=1&draft=a+b");
    expect(greetingFor(9)).toBe("Good morning");
    expect(greetingFor(20)).toBe("Good evening");
  });
});

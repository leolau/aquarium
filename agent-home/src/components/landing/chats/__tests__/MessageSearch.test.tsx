// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/lib/chat/session-list-fetch", () => ({
  fetchSessionList: async (url: string) => {
    const res = await fetch(url);
    return res.ok ? res.json() : null;
  },
}));

import { ChatsSidebar } from "../ChatsSidebar";
import type { MessageSearchHit } from "../MessageSearch";
import { fakeFetch, json, sessions } from "./fixtures";

const hit: MessageSearchHit = {
  session_id: "s-q3",
  snippet: "budget <b>is</b> >>>nightly<<< capped",
  role: "assistant",
  title: "Q3 planning notes",
};

function setup(search: (q: string, signal: AbortSignal) => Promise<MessageSearchHit[]>) {
  vi.stubGlobal("fetch", vi.fn(fakeFetch({ "GET /api/chat/sessions": () => json({ sessions }) })));
  const onOpen = vi.fn();
  render(
    <ChatsSidebar
      profiles={[{ name: "default", is_default: true }] as never}
      searchShortcut="hint"
      messageSearch={vi.fn(search)}
      onOpenMessageHit={onOpen}
    />,
  );
  return { onOpen };
}

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Search chats"), { target: { value } });

describe("ChatsPanel message search", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists hits under 'In messages' beside the title matches and opens the picked chat", async () => {
    const search = vi.fn(async () => [hit]);
    const { onOpen } = setup(search);
    await screen.findByText("Q3 planning notes");
    type("nightly");
    // Title matches are instant; the message search follows the typing pause.
    expect(screen.getByText("can you check why the nightly sync failed")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Searching every conversation");
    const region = await screen.findByRole("region", { name: "In messages" });
    const button = await waitFor(() => {
      const b = region.querySelector<HTMLButtonElement>('[data-action="open-message-hit"]');
      if (!b) throw new Error("no hit yet");
      return b;
    });
    // The snippet is text, not HTML; only the >>>match<<< is marked.
    expect(button.querySelector("b")).toBeNull();
    expect(button.querySelector("mark")?.textContent).toBe("nightly");
    expect(button.textContent).toContain("<b>is</b>");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(hit);
  });

  it("searches once per typing pause and drops answers for an old query", async () => {
    const calls: string[] = [];
    setup(async (q) => {
      calls.push(q);
      return [{ ...hit, title: `hit for ${q}` }];
    });
    await screen.findByText("Q3 planning notes");
    type("ni");
    type("nig");
    type("nightly");
    expect(await screen.findByRole("button", { name: /hit for nightly/ })).toBeTruthy();
    expect(calls).toEqual(["nightly"]);
  });

  it("explains the minimum length instead of searching one letter", async () => {
    const search = vi.fn(async () => [hit]);
    setup(search);
    await screen.findByText("Q3 planning notes");
    type("n");
    expect(screen.getByText(/Type 2 or more letters/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(search).not.toHaveBeenCalled();
  });

  it("shows a retry when the search fails", async () => {
    let fail = true;
    setup(async () => {
      if (fail) throw new Error("boom");
      return [hit];
    });
    await screen.findByText("Q3 planning notes");
    type("nightly");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Message search failed.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /Q3 planning notes.*nightly/ })).toBeTruthy();
  });

  it("shows the shortcut hint without binding it when the page owns the key", async () => {
    setup(async () => []);
    await screen.findByText("Q3 planning notes");
    expect(screen.getByText(/⌘K|Ctrl K/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).not.toBe(screen.getByLabelText("Search chats"));
  });
});

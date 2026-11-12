// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatHeaderActions } from "@/components/chat/ChatHeaderActions";
import { chatHeaderActionsRef, noopChatHeaderActions } from "@/lib/chat/header-actions";

afterEach(() => {
  cleanup();
  chatHeaderActionsRef.current = noopChatHeaderActions();
  vi.useRealTimers();
});

function spies() {
  const ref = {
    startNew: vi.fn(),
    openArchived: vi.fn(),
    openDetails: vi.fn(),
    openChats: vi.fn(),
    toggleFilters: vi.fn(),
    copyChat: vi.fn(async () => true),
  };
  chatHeaderActionsRef.current = ref;
  return ref;
}

describe("ChatHeaderActions on phones", () => {
  it("keeps desktop buttons desktop-only and the phone row phone-only", () => {
    render(<ChatHeaderActions />);
    const desktop = screen.getByText("Details").parentElement!;
    expect(desktop.className).toContain("hidden");
    expect(desktop.className).toContain("lg:flex");
    const phone = document.querySelector('[data-action="chat-menu"]')!.closest("div.lg\\:hidden");
    expect(phone).toBeTruthy();
  });

  it("starts a new chat from the 44px + button", () => {
    const ref = spies();
    render(<ChatHeaderActions />);
    const plus = document.querySelector<HTMLButtonElement>('[data-action="new-chat"]')!;
    expect(plus.getAttribute("aria-label")).toBe("New conversation");
    expect(plus.className).toContain("h-11 w-11");
    fireEvent.click(plus);
    expect(ref.startNew).toHaveBeenCalledTimes(1);
  });

  it("lists every chat action in the ⋯ menu and runs each", () => {
    const ref = spies();
    render(<ChatHeaderActions />);
    const more = screen.getByRole("button", { name: "More chat actions" });
    const cases: [string, keyof typeof ref][] = [
      ["All chats", "openChats"],
      ["Details", "openDetails"],
      ["Filters & search", "toggleFilters"],
      ["Archived", "openArchived"],
    ];
    for (const [label, key] of cases) {
      fireEvent.click(more);
      expect(more.getAttribute("aria-expanded")).toBe("true");
      const menu = screen.getByRole("menu", { name: "Chat actions" });
      const item = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (b) => b.textContent === label,
      )!;
      expect(item.className).toContain("h-11");
      fireEvent.click(item);
      expect(ref[key]).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("confirms Copy chat, then closes the menu", async () => {
    vi.useFakeTimers();
    const ref = spies();
    render(<ChatHeaderActions />);
    fireEvent.click(screen.getByRole("button", { name: "More chat actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy chat" }));
    await act(async () => {});
    expect(ref.copyChat).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitem", { name: "Copied" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu on Escape", () => {
    render(<ChatHeaderActions />);
    fireEvent.click(screen.getByRole("button", { name: "More chat actions" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

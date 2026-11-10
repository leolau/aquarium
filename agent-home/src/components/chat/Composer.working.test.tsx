// @vitest-environment jsdom
/**
 * The composer while the agent works: the box and Send stay usable, Send is a
 * split button (Steer by default; Queue; Stop & send), Stop stays its own red
 * button, and messages the agent has not read yet show as chips above it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/Composer";
import type { PendingChatInput } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function working(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn<(t: string, a: unknown[], m?: string) => Promise<boolean>>(
    async () => true,
  );
  const onStop = vi.fn();
  const utils = render(
    <Composer
      sending
      storageEnabled={false}
      sessionId="s1"
      onSend={onSend}
      onStop={onStop}
      {...props}
    />,
  );
  return { ...utils, onSend, onStop };
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const chooseMode = (name: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: name }));
};

describe("Composer while the agent works", () => {
  it("keeps the box and a Steer send enabled, with Stop beside it", async () => {
    const { onSend, onStop } = working();
    expect(box().disabled).toBe(false);
    const send = screen.getByRole("button", { name: /^steer$/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true); // nothing typed yet
    type("also check the logs");
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("also check the logs", [], "steer"));
    expect(box().value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /stop the agent/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("lists Steer / Queue / Stop & send and sends with the chosen mode", async () => {
    const { onSend } = working();
    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    const menu = screen.getByRole("menu", { name: /send mode/i });
    expect(within(menu).getAllByRole("menuitemradio").map((b) => b.textContent)).toEqual([
      expect.stringContaining("Steer"),
      expect.stringContaining("Queue"),
      expect.stringContaining("Stop & send"),
    ]);
    expect(within(menu).getByRole("menuitemradio", { name: /^.?steer/i }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /queue/i }));
    expect(screen.queryByRole("menu")).toBeNull();

    type("then write the summary");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("then write the summary", [], "queue"));
    // The mode sticks for the next message.
    expect(screen.getByRole("button", { name: /^queue$/i })).toBeTruthy();
  });

  it("Stop & send is one-off: the next message steers again", async () => {
    const { onSend } = working();
    chooseMode(/stop & send/i);
    expect(screen.getByRole("button", { name: /^stop & send$/i })).toBeTruthy();
    type("forget that, do X");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("forget that, do X", [], "interrupt"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^steer$/i })).toBeTruthy());
  });

  it("closes the mode menu on Escape", () => {
    working();
    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("gives the draft back when a mid-turn send fails", async () => {
    working({ onSend: async () => false });
    type("lost");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box().value).toBe("lost"));
  });

  it("shows plain Send (no mode) when idle", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer sending={false} storageEnabled={false} sessionId="s1" onSend={onSend} />);
    expect(screen.queryByRole("button", { name: /choose how to send/i })).toBeNull();
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", []));
  });

  it("can steer while the first turn's onSend is still pending", async () => {
    let finish: (v: boolean) => void = () => {};
    const onSend = vi.fn((_t: string, _a: unknown[], mode?: string) =>
      mode ? Promise.resolve(true) : new Promise<boolean>((r) => (finish = r)),
    );
    const { rerender } = render(
      <Composer sending={false} storageEnabled={false} sessionId="s1" onSend={onSend} />,
    );
    type("start");
    fireEvent.keyDown(box(), { key: "Enter" });
    await act(async () => {});
    rerender(<Composer sending storageEnabled={false} sessionId="s1" onSend={onSend} />);
    type("steer it");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("steer it", [], "steer"));
    finish(true);
  });
});

describe("Composer pending chips", () => {
  const pending: PendingChatInput[] = [
    { itemId: "s1", mode: "steer", text: "look at B", status: "pending" },
    { itemId: "s2", mode: "steer", text: "and D", status: "deferred" },
    { itemId: "q1", mode: "queue", text: "then C", status: "queued" },
  ];

  it("says when each message will be read, and lets a queued one be removed", () => {
    const onRemovePending = vi.fn();
    working({ pending, onRemovePending });
    const chips = within(screen.getByRole("list", { name: /sent while working/i })).getAllByRole(
      "listitem",
    );
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toContain("look at B");
    expect(chips[0].textContent).toContain("will be read after the current step");
    expect(chips[1].textContent).toContain("will run next");
    expect(chips[2].textContent).toContain("Queued next");
    // Only queued messages can be taken back.
    expect(within(chips[0]).queryByRole("button")).toBeNull();
    fireEvent.click(within(chips[2]).getByRole("button", { name: /remove queued message: then c/i }));
    expect(onRemovePending).toHaveBeenCalledWith("q1");
  });

  it("hides chips once the agent is idle", () => {
    render(
      <Composer sending={false} storageEnabled={false} sessionId="s1" onSend={() => true} pending={pending} />,
    );
    expect(screen.queryByRole("list", { name: /sent while working/i })).toBeNull();
  });
});

describe("Composer at 390px", () => {
  it("stacks chips and opens the mode menu as a bottom sheet over a backdrop", () => {
    window.innerWidth = 390;
    window.dispatchEvent(new Event("resize"));
    working({ pending: [{ itemId: "q1", mode: "queue", text: "then C", status: "queued" }] });
    const chips = screen.getByRole("list", { name: /sent while working/i });
    // One chip per row; a long one truncates inside its own row.
    expect(chips.className).toContain("flex-col");
    expect(within(chips).getByText(/then C/).className).toContain("truncate");

    fireEvent.click(screen.getByRole("button", { name: /choose how to send/i }));
    const sheet = screen.getByRole("menu");
    // Below the `sm` breakpoint the menu pins to the bottom edge, full width.
    for (const cls of ["max-sm:fixed", "max-sm:inset-x-0", "max-sm:bottom-0", "max-sm:rounded-t-2xl"]) {
      expect(sheet.className).toContain(cls);
    }
    const backdrop = document.querySelector('[data-component="SendModeBackdrop"]') as HTMLElement;
    expect(backdrop.className).toContain("sm:hidden");
    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatStreamHandlers } from "@/lib/chat/stream";

vi.mock("@/lib/chat/stream", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/stream")>()),
  streamChatTurn: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatTurn: vi.fn(),
  steerChatTurn: vi.fn(),
  removeQueuedInput: vi.fn(),
}));
// Link's useLinkStatus only works inside the App Router's link context.
vi.mock("next/link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/link")>();
  return {
    ...actual,
    useLinkStatus: () => ({ pending: false }),
  };
});

import {
  attachChatStream,
  cancelChatTurn,
  steerChatTurn,
  streamChatTurn,
} from "@/lib/chat/stream";
import { LeadChatHost } from "@/components/coral/LeadChatHost";

// jsdom has no PointerEvent constructor; RTL builds one for pointer* events.
class FakePointerEvent extends MouseEvent {
  pointerType = "mouse";
}
(globalThis as Record<string, unknown>).PointerEvent ??= FakePointerEvent;

const openLeadChat = () =>
  fireEvent.click(screen.getByRole("button", { name: /open lead chat/i }));

async function sendMessage(text: string) {
  fireEvent.input(screen.getByPlaceholderText(/message your agent/i), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
}

/**
 * A fetch stub answering the panel's three reads: which conversation it is,
 * its history, and whether a turn is already in flight. `overrides` replaces
 * the body for a path prefix.
 */
function leadFetch(overrides: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown> = {
    "/api/chat/lead": { sessionId: "lead-abc" },
    "/api/chat/messages": { messages: [] },
    "/api/chat/active": { runId: null },
    ...overrides,
  };
  const fetchMock = vi.fn(async (url: string) => {
    const key = Object.keys(bodies).find((k) => url.startsWith(k));
    return { ok: true, json: async () => (key ? bodies[key] : {}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.mocked(streamChatTurn).mockReset();
  vi.mocked(attachChatStream).mockReset();
  vi.mocked(attachChatStream).mockResolvedValue(undefined);
  vi.mocked(cancelChatTurn).mockReset();
  vi.mocked(cancelChatTurn).mockResolvedValue(undefined);
  vi.mocked(steerChatTurn).mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LeadChatHost (SSR)", () => {
  it("renders the FAB closed — no panel in server markup", () => {
    const html = renderToStaticMarkup(<LeadChatHost />);
    expect(html).toContain('data-component="LeadChatHost"');
    expect(html).toContain("Open lead chat");
    expect(html).not.toContain('role="dialog"');
  });
});

describe("LeadChatHost panel", () => {
  it("opens on tap with the lead-session header and a composer", () => {
    render(<LeadChatHost />);
    openLeadChat();
    const panel = screen.getByRole("dialog", { name: /lead chat/i });
    expect(panel.textContent).toContain("Lead chat");
    expect(panel.textContent).toContain(
      "The lead session starts with your first message",
    );
    expect(screen.getByPlaceholderText(/message your agent/i)).toBeTruthy();
  });

  it("offers a jump to the Chats page", () => {
    render(<LeadChatHost />);
    openLeadChat();
    const link = screen.getByRole("link", { name: /chats/i });
    expect(link.getAttribute("href")).toBe("/chat");
  });

  it("closes on the Close button", () => {
    render(<LeadChatHost />);
    openLeadChat();
    expect(screen.queryByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape", () => {
    render(<LeadChatHost />);
    openLeadChat();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides the floating button while the panel is open", () => {
    render(<LeadChatHost />);
    openLeadChat();
    expect(screen.getByRole("dialog", { name: /lead chat/i })).toBeTruthy();
    // The FAB carries aria-label "Close lead chat" when open, but it is
    // hidden — role queries skip hidden elements, so nothing matches.
    expect(screen.queryByRole("button", { name: /open lead chat/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /close lead chat/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.getByRole("button", { name: /open lead chat/i })).toBeTruthy();
  });

  it("loads the server's lead session, and its history, on open", async () => {
    const fetchMock = leadFetch({
      "/api/chat/messages": {
        messages: [{ role: "assistant", content: "Earlier answer" }],
      },
    });

    render(<LeadChatHost />);
    openLeadChat();

    await waitFor(() => {
      expect(screen.getByRole("dialog").textContent).toContain("Earlier answer");
    });
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/chat/lead");
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
      "/api/chat/messages?sessionId=lead-abc",
    );
  });

  it("sends every turn on the server's lead session, never a fresh one", async () => {
    leadFetch();
    const mocked = vi.mocked(streamChatTurn);
    mocked.mockImplementation(async (_params, handlers: ChatStreamHandlers) => {
      // A compacted conversation answers under a continuation id; adopting
      // it here would fork this browser off the shared lead session.
      handlers.onCompleted?.("Hi there", "resume-99");
      return { sessionId: "resume-99" };
    });

    render(<LeadChatHost />);
    openLeadChat();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message your agent/i)).toBeTruthy();
    });
    await sendMessage("Hello");
    await waitFor(() => {
      expect(screen.getByRole("dialog").textContent).toContain("Hi there");
    });
    expect(mocked.mock.calls[0][0].sessionId).toBe("lead-abc");

    await sendMessage("More");
    await waitFor(() => {
      expect(mocked).toHaveBeenCalledTimes(2);
    });
    expect(mocked.mock.calls[1][0].sessionId).toBe("lead-abc");
  });

  it("re-attaches to a turn another device left running", async () => {
    leadFetch({ "/api/chat/active": { runId: "run-7" } });
    vi.mocked(attachChatStream).mockImplementation(async (_params, handlers) => {
      handlers.onDelta?.("…still going");
    });

    render(<LeadChatHost />);
    openLeadChat();

    await waitFor(() => {
      expect(vi.mocked(attachChatStream)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(attachChatStream).mock.calls[0][0]).toMatchObject({
      sessionId: "lead-abc",
      runId: "run-7",
    });
    expect(vi.mocked(attachChatStream).mock.calls[0][0].signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("shows the shared phase indicator: sending until the server ack, then thinking with a clock", async () => {
    leadFetch();
    let handlers: ChatStreamHandlers | null = null;
    vi.mocked(streamChatTurn).mockImplementation(
      (_params, h) =>
        new Promise(() => {
          handlers = h;
        }),
    );

    render(<LeadChatHost />);
    openLeadChat();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message your agent/i)).toBeTruthy();
    });
    await sendMessage("Long task");

    const status = () => screen.getByRole("status");
    await waitFor(() => {
      expect(status().getAttribute("data-activity")).toBe("sending");
    });
    handlers!.onAccepted?.("run-1", "lead-abc");
    await waitFor(() => {
      expect(status().getAttribute("data-activity")).toBe("thinking");
    });
    handlers!.onToolStart?.({ id: "t1", name: "web_search" });
    await waitFor(() => {
      expect(status().getAttribute("data-activity")).toBe("tool");
      expect(status().textContent).toContain("web_search");
    });
    expect(screen.getByRole("button", { name: /stop the agent/i })).toBeTruthy();
  });

  it("Stop asks the server to cancel the run instead of only closing the stream", async () => {
    leadFetch();
    let handlers: ChatStreamHandlers | null = null;
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(streamChatTurn).mockImplementation(
      (params, h) =>
        new Promise(() => {
          handlers = h;
          receivedSignal = params.signal;
        }),
    );

    render(<LeadChatHost />);
    openLeadChat();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message your agent/i)).toBeTruthy();
    });
    await sendMessage("Long task");
    await waitFor(() => expect(handlers).not.toBeNull());
    handlers!.onAccepted?.("run-1", "lead-abc");
    await waitFor(() => {
      expect(screen.getByRole("status").getAttribute("data-activity")).toBe("thinking");
    });

    fireEvent.click(screen.getByRole("button", { name: /stop the agent/i }));
    await waitFor(() => {
      expect(vi.mocked(cancelChatTurn)).toHaveBeenCalledWith({
        sessionId: "lead-abc",
        runId: "run-1",
      });
    });
    // The stream stays open so the partial reply still lands.
    expect(receivedSignal?.aborted).toBe(false);
    expect(screen.getByRole("button", { name: /stopping the agent/i })).toBeTruthy();
    handlers!.onCancelled?.();
    await waitFor(() => {
      expect(screen.getByRole("dialog").textContent).toContain("Stopped");
    });
  });

  it("Stop before the server ack aborts the request", async () => {
    leadFetch();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(streamChatTurn).mockImplementation(
      (params) =>
        new Promise((_resolve, reject) => {
          receivedSignal = params.signal;
          params.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    render(<LeadChatHost />);
    openLeadChat();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message your agent/i)).toBeTruthy();
    });
    await sendMessage("Long task");
    await waitFor(() => expect(receivedSignal).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /stop the agent/i }));
    expect(receivedSignal?.aborted).toBe(true);
    expect(vi.mocked(cancelChatTurn)).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
    });
  });

  it("refuses to send rather than fork a private conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const mocked = vi.mocked(streamChatTurn);

    render(<LeadChatHost />);
    openLeadChat();
    await sendMessage("Hello");

    await waitFor(() => {
      expect(screen.getByRole("dialog").textContent).toContain(
        "could not be reached",
      );
    });
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe("LeadChatHost move & resize", () => {
  it("persists a new position after dragging the header", () => {
    render(<LeadChatHost />);
    openLeadChat();
    const grip = document.querySelector(".leadchat-drag") as Element;
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 140, clientY: 300 });

    const stored = JSON.parse(
      localStorage.getItem("agent-home:leadchat-rect") ?? "null",
    ) as { x: number; y: number; w: number; h: number } | null;
    expect(stored).toBeTruthy();
    expect(typeof stored?.x).toBe("number");
    expect(typeof stored?.y).toBe("number");
    expect(stored?.w).toBeGreaterThanOrEqual(260);
    expect(stored?.h).toBeGreaterThanOrEqual(240);
  });

  it("persists a new size after dragging the corner grip", () => {
    render(<LeadChatHost />);
    openLeadChat();
    const handle = document.querySelector(".leadchat-resize") as Element;
    fireEvent.pointerDown(handle, { clientX: 300, clientY: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 480 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 480 });

    const stored = JSON.parse(
      localStorage.getItem("agent-home:leadchat-rect") ?? "null",
    ) as { w: number; h: number } | null;
    expect(stored).toBeTruthy();
    expect(stored?.w).toBeGreaterThanOrEqual(260);
    expect(stored?.h).toBeGreaterThanOrEqual(240);
  });

  it("persists a new size after dragging the upper-left grip", () => {
    // Seed a known box so the math is deterministic: dragging the top-left
    // corner outward 30x20 grows the panel while anchoring bottom-right.
    localStorage.setItem(
      "agent-home:leadchat-rect",
      JSON.stringify({ x: 100, y: 100, w: 300, h: 300 }),
    );
    render(<LeadChatHost />);
    openLeadChat();
    const handle = document.querySelector(".leadchat-resize-tl") as Element;
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 70, clientY: 80 });
    fireEvent.pointerUp(window, { clientX: 70, clientY: 80 });

    const stored = JSON.parse(
      localStorage.getItem("agent-home:leadchat-rect") ?? "null",
    );
    expect(stored).toEqual({ x: 70, y: 80, w: 330, h: 320 });
  });

  it("restores the persisted rect on the next open", () => {
    localStorage.setItem(
      "agent-home:leadchat-rect",
      JSON.stringify({ x: 33, y: 77, w: 300, h: 330 }),
    );
    render(<LeadChatHost />);
    openLeadChat();
    const panel = screen.getByRole("dialog", { name: /lead chat/i });
    expect(panel.style.left).toBe("33px");
    expect(panel.style.top).toBe("77px");
    expect(panel.style.width).toBe("300px");
    expect(panel.style.height).toBe("330px");
  });
});

describe("LeadChatHost while the agent works", () => {
  it("steers a second message into the running turn and follows run.chained", async () => {
    leadFetch();
    let handlers: ChatStreamHandlers | null = null;
    let finish: () => void = () => {};
    vi.mocked(streamChatTurn).mockImplementation(
      (_params, h) =>
        new Promise((resolve) => {
          handlers = h;
          finish = () => resolve({ sessionId: "lead-abc" });
        }),
    );
    vi.mocked(steerChatTurn).mockResolvedValue({ itemId: "i1", mode: "steer", status: "pending" });
    let chainedHandlers: ChatStreamHandlers | null = null;
    vi.mocked(attachChatStream).mockImplementation(
      (_params, h) =>
        new Promise(() => {
          chainedHandlers = h;
        }),
    );

    render(<LeadChatHost />);
    openLeadChat();
    await waitFor(() => expect(screen.getByPlaceholderText(/message your agent/i)).toBeTruthy());
    await sendMessage("Plan the week");
    await waitFor(() => expect(handlers).not.toBeNull());
    handlers!.onAccepted?.("run-1", "lead-abc");

    const box = await screen.findByPlaceholderText(/steer the agent/i);
    fireEvent.input(box, { target: { value: "include Friday" } });
    fireEvent.click(screen.getByRole("button", { name: /^steer$/i }));
    await waitFor(() =>
      expect(vi.mocked(steerChatTurn)).toHaveBeenCalledWith({
        sessionId: "lead-abc",
        runId: "run-1",
        text: "include Friday",
        mode: "steer",
      }),
    );
    expect(vi.mocked(streamChatTurn)).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("list", { name: /sent while working/i }).textContent).toContain(
        "will be read after the current step",
      ),
    );

    handlers!.onInputSteered?.("i1");
    await waitFor(() =>
      expect(document.querySelector('[data-sent-while-working="true"]') ?? screen.getByText("include Friday")).toBeTruthy(),
    );
    expect(screen.queryByRole("list", { name: /sent while working/i })).toBeNull();

    handlers!.onRunChained?.({ nextRunId: "run-2", itemId: "q1", text: "then email it", source: "queue" });
    finish();
    await waitFor(() =>
      expect(vi.mocked(attachChatStream).mock.calls[0]?.[0]).toMatchObject({
        sessionId: "lead-abc",
        runId: "run-2",
      }),
    );
    expect(chainedHandlers).not.toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("then email it");
    // Still working: Stop is there and Send still steers.
    expect(screen.getByRole("button", { name: /stop the agent/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^steer$/i })).toBeTruthy();
  });

  it("redraws chips from /api/chat/active on reopen", async () => {
    leadFetch({
      "/api/chat/active": {
        runId: "run-7",
        pending: [{ itemId: "q1", mode: "queue", text: "then email it", status: "queued" }],
      },
    });
    vi.mocked(attachChatStream).mockImplementation(() => new Promise(() => {}));
    render(<LeadChatHost />);
    openLeadChat();
    const chips = await screen.findByRole("list", { name: /sent while working/i });
    expect(chips.textContent).toContain("then email it");
    expect(screen.getByRole("button", { name: /remove queued message/i })).toBeTruthy();
  });
});

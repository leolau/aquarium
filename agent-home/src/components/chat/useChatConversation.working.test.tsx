// @vitest-environment jsdom
/**
 * Interactive prompting in the main chat: a message sent while a turn runs
 * goes to that turn (steer / queue / Stop & send), its chip tracks the
 * server's events, a chained run is followed without dropping the busy
 * state, and a reload redraws the chips. The backend is mocked by contract.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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

import { useChatConversation } from "@/components/chat/useChatConversation";
import {
  attachChatStream,
  removeQueuedInput,
  RunFinishedError,
  steerChatTurn,
  streamChatTurn,
} from "@/lib/chat/stream";

let activeBody: unknown = { runId: null };

beforeEach(() => {
  activeBody = { runId: null };
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(url.startsWith("/api/chat/active") ? activeBody : { messages: [] }),
        { status: 200 },
      ),
    ),
  );
  for (const fn of [streamChatTurn, attachChatStream, steerChatTurn, removeQueuedInput]) {
    vi.mocked(fn).mockReset();
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  renderHook(() =>
    useChatConversation({
      profile: "work",
      initialSessionId: "s1",
      initialMessages: [],
      findSession: () => undefined,
      onSessionsStale: () => {},
    }),
  );

/** A turn whose stream stays open until `end()`; `h()` are its handlers. */
function controlledStream(mock: typeof streamChatTurn | typeof attachChatStream) {
  const turns: { h: ChatStreamHandlers; end: () => void }[] = [];
  vi.mocked(mock).mockImplementation(
    ((_params: unknown, handlers: ChatStreamHandlers) =>
      new Promise((resolve) => {
        turns.push({ h: handlers, end: () => resolve({ sessionId: "s1" } as never) });
      })) as never,
  );
  return turns;
}

async function startWorkingTurn(result: ReturnType<typeof mount>["result"]) {
  const turns = controlledStream(streamChatTurn);
  act(() => {
    void result.current.send("fix the build", []);
  });
  await waitFor(() => expect(turns).toHaveLength(1));
  act(() => turns[0].h.onAccepted?.("run_1", "s1"));
  expect(result.current.selBusy).toBe(true);
  return turns;
}

describe("useChatConversation while a turn runs", () => {
  it("steers into the running turn and shows the bubble once the agent reads it", async () => {
    const { result } = mount();
    const turns = await startWorkingTurn(result);
    vi.mocked(steerChatTurn).mockResolvedValue({ itemId: "i1", mode: "steer", status: "pending" });

    await act(async () => {
      expect(await result.current.send("use the staging config", [], "steer")).toBe(true);
    });
    expect(steerChatTurn).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "run_1",
      text: "use the staging config",
      mode: "steer",
      profile: "work",
    });
    expect(streamChatTurn).toHaveBeenCalledTimes(1);
    expect(result.current.selPending).toEqual([
      { itemId: "i1", mode: "steer", text: "use the staging config", status: "pending" },
    ]);

    act(() => turns[0].h.onInputSteered?.("i1"));
    expect(result.current.selPending).toEqual([]);
    const steered = result.current.messages.filter((m) => m.sentWhileWorking);
    expect(steered).toEqual([
      { role: "user", content: "use the staging config", sentWhileWorking: true },
    ]);
    // The reply keeps streaming into the bubble after it.
    expect(result.current.messages.at(-1)?.role).toBe("assistant");
  });

  it("marks a steer the turn didn't read as 'will run next'", async () => {
    const { result } = mount();
    const turns = await startWorkingTurn(result);
    act(() => turns[0].h.onInputAccepted?.({ itemId: "i1", mode: "steer", text: "x" }));
    act(() => turns[0].h.onInputDeferred?.("i1"));
    expect(result.current.selPending[0].status).toBe("deferred");
  });

  it("removes a queued chip through the queue-remove call", async () => {
    const { result } = mount();
    const turns = await startWorkingTurn(result);
    act(() => turns[0].h.onInputAccepted?.({ itemId: "q1", mode: "queue", text: "then C" }));
    vi.mocked(removeQueuedInput).mockResolvedValue(true);
    await act(async () => result.current.removePending("q1"));
    expect(removeQueuedInput).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "run_1",
      itemId: "q1",
      profile: "work",
    });
    expect(result.current.selPending).toEqual([]);
  });

  it("follows run.chained to the next run and stays busy throughout", async () => {
    const { result } = mount();
    const turns = await startWorkingTurn(result);
    const attached = controlledStream(attachChatStream);
    act(() => turns[0].h.onInputAccepted?.({ itemId: "q1", mode: "queue", text: "then C" }));
    act(() =>
      turns[0].h.onRunChained?.({ nextRunId: "run_2", itemId: "q1", text: "then C", source: "queue" }),
    );
    act(() => turns[0].end());

    await waitFor(() => expect(attached).toHaveLength(1));
    expect(vi.mocked(attachChatStream).mock.calls[0][0]).toMatchObject({
      sessionId: "s1",
      runId: "run_2",
    });
    expect(result.current.selBusy).toBe(true);
    expect(result.current.selPending).toEqual([]);
    expect(result.current.liveActivity.s1?.runId).toBe("run_2");
    expect(result.current.messages.slice(-2)).toEqual([
      { role: "user", content: "then C" },
      { role: "assistant", content: "" },
    ]);

    // Steering now targets the chained run.
    vi.mocked(steerChatTurn).mockResolvedValue({ itemId: "i2", mode: "steer", status: "pending" });
    await act(async () => {
      await result.current.send("faster", [], "steer");
    });
    expect(vi.mocked(steerChatTurn).mock.calls[0][0].runId).toBe("run_2");

    await act(async () => attached[0].end());
    await waitFor(() => expect(result.current.selBusy).toBe(false));
  });

  it("sends a normal turn when the run already finished (409 run_finished)", async () => {
    const { result } = mount();
    const turns = await startWorkingTurn(result);
    vi.mocked(steerChatTurn).mockImplementation(async () => {
      turns[0].end();
      throw new RunFinishedError();
    });
    act(() => {
      void result.current.send("one more thing", [], "steer");
    });
    await waitFor(() => expect(streamChatTurn).toHaveBeenCalledTimes(2));
    expect(vi.mocked(streamChatTurn).mock.calls[1][0].message).toBe("one more thing");
  });

  it("redraws chips from /api/chat/active after a reload", async () => {
    activeBody = {
      runId: "run_9",
      pending: [{ itemId: "q1", mode: "queue", text: "then C", status: "queued" }],
    };
    const attached = controlledStream(attachChatStream);
    const { result } = mount();
    await waitFor(() => expect(attached).toHaveLength(1));
    expect(result.current.selBusy).toBe(true);
    expect(result.current.selPending).toEqual([
      { itemId: "q1", mode: "queue", text: "then C", status: "queued" },
    ]);
    activeBody = { runId: null };
    await act(async () => attached[0].end());
    await waitFor(() => expect(result.current.selPending).toEqual([]));
  });
});

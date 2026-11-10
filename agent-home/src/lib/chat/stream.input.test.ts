import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachChatStream,
  removeQueuedInput,
  RunFinishedError,
  steerChatTurn,
  streamChatTurn,
  TurnInProgressError,
  type ChatRunChain,
} from "@/lib/chat/stream";

const frames = (...lines: string[]) => lines.join("\n\n") + "\n\n";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stream events for messages sent while working", () => {
  it("dispatches input.* and run.chained, ignoring malformed frames", async () => {
    const body = frames(
      'event: run.accepted\ndata: {"run_id":"r1","session_id":"s1"}',
      'event: input.accepted\ndata: {"run_id":"r1","item_id":"i1","mode":"steer","text":"look at B"}',
      'event: input.accepted\ndata: {"run_id":"r1","item_id":"i9","mode":"yell","text":"x"}',
      'event: input.accepted\ndata: {"run_id":"r1","item_id":"i2","mode":"queue","text":"then C"}',
      'event: input.steered\ndata: {"run_id":"r1","item_id":"i1"}',
      'event: input.deferred\ndata: {"run_id":"r1","item_id":"i3"}',
      'event: input.removed\ndata: {"run_id":"r1","item_id":"i2"}',
      'event: input.steered\ndata: {"run_id":"r1"}',
      'event: run.chained\ndata: {"run_id":"r1","next_run_id":"r2","item_id":"i3","text":"look at B","source":"steer_leftover"}',
      'event: run.chained\ndata: {"run_id":"r1","item_id":"i4"}',
      "event: done\ndata: {}",
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const seen: string[] = [];
    const chains: ChatRunChain[] = [];
    await attachChatStream(
      { sessionId: "s1", runId: "r1" },
      {
        onInputAccepted: (i) => seen.push(`accepted:${i.itemId}:${i.mode}:${i.text}`),
        onInputSteered: (id) => seen.push(`steered:${id}`),
        onInputDeferred: (id) => seen.push(`deferred:${id}`),
        onInputRemoved: (id) => seen.push(`removed:${id}`),
        onRunChained: (c) => chains.push(c),
      },
    );
    expect(seen).toEqual([
      "accepted:i1:steer:look at B",
      "accepted:i2:queue:then C",
      "steered:i1",
      "deferred:i3",
      "removed:i2",
    ]);
    expect(chains).toEqual([
      { nextRunId: "r2", itemId: "i3", text: "look at B", source: "steer_leftover" },
    ]);
  });
});

describe("steerChatTurn / removeQueuedInput", () => {
  it("posts the mode to /api/chat/steer and returns the item", async () => {
    const fetchMock = vi.fn(async () =>
      json({ run_id: "r1", mode: "queue", item_id: "i7", status: "queued" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const item = await steerChatTurn({ sessionId: "s1", runId: "r1", text: "then C", mode: "queue", profile: "work" });
    expect(item).toEqual({ itemId: "i7", mode: "queue", status: "queued" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chat/steer");
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: "s1",
      runId: "r1",
      text: "then C",
      mode: "queue",
      profile: "work",
    });
  });

  it("raises RunFinishedError on 409 run_finished, and the detail otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "run_finished" }, 409)));
    await expect(
      steerChatTurn({ sessionId: "s1", runId: "r1", text: "x", mode: "steer" }),
    ).rejects.toBeInstanceOf(RunFinishedError);
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "Run not found" }, 404)));
    await expect(
      steerChatTurn({ sessionId: "s1", runId: "r1", text: "x", mode: "steer" }),
    ).rejects.toThrow("Run not found");
  });

  it("removes a queued item through /api/chat/queue/remove", async () => {
    const fetchMock = vi.fn(async () => json({ removed: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await removeQueuedInput({ sessionId: "s1", runId: "r1", itemId: "i2" })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chat/queue/remove");
    expect(JSON.parse(init.body as string)).toMatchObject({ sessionId: "s1", runId: "r1", itemId: "i2" });
  });

  it("streamChatTurn raises TurnInProgressError with the live run on a busy session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "turn_in_progress", detail: "turn_in_progress", runId: "r_live" }, 409)),
    );
    const err = await streamChatTurn({ sessionId: "s1", message: "hi", attachments: [] }, {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TurnInProgressError);
    expect((err as TurnInProgressError).runId).toBe("r_live");
  });
});

import { describe, expect, it } from "vitest";

import {
  dropPending,
  markDeferred,
  pendingFromActive,
  upsertPending,
} from "@/lib/chat/pending-inputs";
import type { PendingChatInput } from "@/types";

const steer: PendingChatInput = { itemId: "a", mode: "steer", text: "look at B", status: "pending" };
const queued: PendingChatInput = { itemId: "b", mode: "queue", text: "then C", status: "queued" };

describe("pending inputs", () => {
  it("adds each item once, however often the server repeats it", () => {
    const once = upsertPending([], steer);
    expect(upsertPending(once, steer)).toEqual([steer]);
    expect(upsertPending(once, queued)).toEqual([steer, queued]);
  });

  it("keeps a deferred steer deferred when its accept is replayed", () => {
    const deferred = markDeferred([steer], "a");
    expect(deferred[0].status).toBe("deferred");
    expect(upsertPending(deferred, steer)[0].status).toBe("deferred");
  });

  it("drops by id and ignores unknown ids", () => {
    const list = [steer, queued];
    expect(dropPending(list, "a")).toEqual([queued]);
    expect(dropPending(list, "zzz")).toBe(list);
  });

  it("reads /api/chat/active pending defensively", () => {
    expect(
      pendingFromActive([
        { itemId: "a", mode: "steer", text: "look at B" },
        { itemId: "b", mode: "queue", text: "then C" },
        { itemId: "c", mode: "interrupt", text: "stop" },
        { itemId: "d", mode: "yell", text: "bad mode" },
        { mode: "queue", text: "no id" },
        null,
      ]),
    ).toEqual([
      steer,
      queued,
      { itemId: "c", mode: "interrupt", text: "stop", status: "queued" },
    ]);
    expect(pendingFromActive(undefined)).toEqual([]);
  });
});

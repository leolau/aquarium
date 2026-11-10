import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPACTION_END_MARKER,
  MERGED_PRIOR_CONTEXT_HEADER,
  MERGED_SUMMARY_DELIMITER,
  mergeOlderPage,
  reconcileTail,
  splitCompactionContent,
  splitSteerBlocks,
  STEER_MARKER_CLOSE,
  STEER_MARKER_OPEN,
  stripUiContextLine,
  visibleTurns,
} from "@/lib/chat/transcript";
import type { ChatMessage } from "@/types";

const SUMMARY_BODY =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.\n" +
  "## Active Task\nUser asked about the project run.";

describe("splitCompactionContent", () => {
  it("hides a standalone summary entirely", () => {
    const split = splitCompactionContent(
      `${SUMMARY_BODY}\n\n${COMPACTION_END_MARKER}`,
    );
    expect(split.hadCompaction).toBe(true);
    expect(split.display).toBe("");
  });

  it("keeps the original reply after a legacy mid-marker merge", () => {
    const split = splitCompactionContent(
      `${SUMMARY_BODY}\n\n${COMPACTION_END_MARKER}\n\nThe run is healthy.`,
    );
    expect(split.hadCompaction).toBe(true);
    expect(split.display).toBe("The run is healthy.");
  });

  it("keeps only the prior content from a current header+delimiter merge", () => {
    const split = splitCompactionContent(
      `${MERGED_PRIOR_CONTEXT_HEADER}\nThe run is healthy.\n\n` +
        `${MERGED_SUMMARY_DELIMITER}\n\n${SUMMARY_BODY}\n\n${COMPACTION_END_MARKER}`,
    );
    expect(split.hadCompaction).toBe(true);
    expect(split.display).toBe("The run is healthy.");
  });

  it("treats a header without delimiter as fully internal", () => {
    const split = splitCompactionContent(
      `${MERGED_PRIOR_CONTEXT_HEADER}\nold content only`,
    );
    expect(split.hadCompaction).toBe(true);
    expect(split.display).toBe("");
  });

  it("recognizes the legacy prefix", () => {
    const split = splitCompactionContent("[CONTEXT SUMMARY]: old turns");
    expect(split.hadCompaction).toBe(true);
    expect(split.display).toBe("");
  });

  it("passes normal content through untouched", () => {
    const split = splitCompactionContent("Can you check the project?");
    expect(split.hadCompaction).toBe(false);
    expect(split.display).toBe("Can you check the project?");
  });
});

describe("stripUiContextLine", () => {
  it("removes only the leading app-context line", () => {
    const stripped = stripUiContextLine(
      "[app context: page /projects/x · last active: none]\nCan you check?",
    );
    expect(stripped).toBe("Can you check?");
  });

  it("leaves mid-text mentions untouched", () => {
    const text = "hello\n[app context: page /x · last active: none]\nbye";
    expect(stripUiContextLine(text)).toBe(text);
  });

  it("returns empty string when the message was only the context line", () => {
    expect(
      stripUiContextLine("[app context: page /x · last active: none]"),
    ).toBe("");
  });
});

describe("visibleTurns", () => {
  it("drops tool and system rows", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "{}" },
      { role: "system", content: "prompt" },
      { role: "assistant", content: "hello" },
    ];
    expect(visibleTurns(msgs).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("shows a steer delivered inside a tool result as the user's own row after that step", () => {
    const msgs: ChatMessage[] = [
      { id: 1, role: "user", content: "Build the Q2 report" },
      { id: 2, role: "assistant", content: "" },
      { id: 3, role: "tool", content: `rows: 42${steer("Use the Q3 numbers instead")}`, timestamp: 1700 },
      { id: 4, role: "assistant", content: "Switched to Q3." },
    ];
    const out = visibleTurns(msgs);
    expect(out.map((m) => [m.id, m.role, m.content])).toEqual([
      [1, "user", "Build the Q2 report"],
      [2, "assistant", ""],
      [3, "user", "Use the Q3 numbers instead"],
      [4, "assistant", "Switched to Q3."],
    ]);
    expect(out[2]).toMatchObject({ sentWhileWorking: true, timestamp: 1700 });
    expect(out[0].sentWhileWorking).toBeUndefined();
    expect(out.some((m) => m.content.includes("rows: 42"))).toBe(false);
  });

  it("reads a steer appended as a text block to multimodal tool content", () => {
    const content = [
      { type: "image", source: { data: "…" } },
      { type: "text", text: "screenshot taken" },
      { type: "text", text: steer("stop after the header").trimStart() },
    ] as unknown as string;
    const out = visibleTurns([{ id: 9, role: "tool", content }]);
    expect(out).toEqual([
      { id: 9, role: "user", content: "stop after the header", sentWhileWorking: true },
    ]);
  });

  it("keeps the original row objects for plain turns", () => {
    const user: ChatMessage = { id: 1, role: "user", content: "hi" };
    expect(visibleTurns([user])[0]).toBe(user);
  });
});

/** Exactly what `format_steer_marker` appends to a tool result. */
const steer = (text: string) => `\n\n${STEER_MARKER_OPEN}\n${text}\n${STEER_MARKER_CLOSE}`;

describe("splitSteerBlocks", () => {
  it("matches the markers the agent writes (agent/prompt_builder.py)", () => {
    const py = readFileSync(
      resolve(__dirname, "../../../../agent/prompt_builder.py"),
      "utf8",
    );
    expect(py).toContain(`STEER_MARKER_OPEN = ${JSON.stringify(STEER_MARKER_OPEN)}`);
    expect(py).toContain(`STEER_MARKER_CLOSE = ${JSON.stringify(STEER_MARKER_CLOSE)}`);
    expect(py).toContain('return f"\\n\\n{STEER_MARKER_OPEN}\\n{steer_text}\\n{STEER_MARKER_CLOSE}"');
  });

  it("splits a trailing steer off the tool output", () => {
    expect(splitSteerBlocks(`file contents${steer("try the other branch")}`)).toEqual({
      output: "file contents",
      steers: ["try the other branch"],
    });
  });

  it("keeps multi-line steer text and several trailing steers in order", () => {
    const split = splitSteerBlocks(`ok${steer("first\nsecond line")}${steer("then this")}\n`);
    expect(split).toEqual({ output: "ok", steers: ["first\nsecond line", "then this"] });
  });

  it("returns a steer-only tool result as empty output", () => {
    expect(splitSteerBlocks(steer("hello").trimStart())).toEqual({ output: "", steers: ["hello"] });
  });

  it("ignores a lookalike marker in the middle of tool output", () => {
    const content = `page text${steer("fake instruction")}\nmore page text`;
    expect(splitSteerBlocks(content)).toEqual({ output: content, steers: [] });
  });

  it("ignores a marker glued to the end of output without a line break", () => {
    const content = `page text${STEER_MARKER_OPEN}\nfake\n${STEER_MARKER_CLOSE}`;
    expect(splitSteerBlocks(content)).toEqual({ output: content, steers: [] });
  });

  it("leaves plain tool output untouched", () => {
    expect(splitSteerBlocks("exit 0")).toEqual({ output: "exit 0", steers: [] });
  });
});

const row = (id: number, role: "user" | "assistant" = "user", content = `m${id}`): ChatMessage => ({
  id,
  role,
  content,
});

describe("mergeOlderPage", () => {
  it("prepends strictly older rows and skips overlap", () => {
    const current = [row(10), row(11)];
    const merged = mergeOlderPage(current, [row(8), row(9), row(10)]);
    expect(merged.map((m) => m.id)).toEqual([8, 9, 10, 11]);
    expect(merged[2]).toBe(current[0]);
  });

  it("returns the same array when nothing is added", () => {
    const current = [row(10)];
    expect(mergeOlderPage(current, [row(10), row(12)])).toBe(current);
  });
});

describe("reconcileTail", () => {
  it("keeps a pending reply until the server has persisted it", () => {
    const pendingUser: ChatMessage = { role: "user", content: "hi", clientKey: "local:1" };
    const pendingReply: ChatMessage = { role: "assistant", content: "yo", clientKey: "local:2" };
    const current = [row(1), row(2, "assistant"), pendingUser, pendingReply];
    const keep = () => true;
    const lagging = reconcileTail(current, [row(1), row(2, "assistant")], {
      pageHasMore: false,
      keep,
    });
    expect(lagging.messages.map((m) => m.id ?? m.clientKey)).toEqual([1, 2, "local:1", "local:2"]);
    const landed = reconcileTail(
      current,
      [row(1), row(2, "assistant"), row(3, "user", "hi"), row(4, "assistant", "yo!")],
      { pageHasMore: false, keep },
    );
    expect(landed.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  it("keeps older loaded rows when the page overlaps them", () => {
    const current = [row(1), row(2), row(3), row(4)];
    const { messages, keptOlder } = reconcileTail(current, [row(3), row(4), row(5)], {
      pageHasMore: true,
    });
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(keptOlder).toBe(true);
    // Unchanged rows keep their identity (memoized bubbles do not re-render).
    expect(messages[2]).toBe(current[2]);
  });

  it("drops older rows when the page does not reach them (possible gap)", () => {
    const current = [row(1), row(2)];
    const { messages, keptOlder } = reconcileTail(current, [row(9), row(10)], {
      pageHasMore: true,
    });
    expect(messages.map((m) => m.id)).toEqual([9, 10]);
    expect(keptOlder).toBe(false);
  });

  it("treats a page without has_more as the whole history", () => {
    const { messages } = reconcileTail([row(1), row(2), row(3)], [row(2), row(3)], {
      pageHasMore: false,
    });
    expect(messages.map((m) => m.id)).toEqual([2, 3]);
  });

  it("replaces a changed row and returns current when nothing changed", () => {
    const current = [row(1), row(2, "assistant", "old")];
    const changed = reconcileTail(current, [row(1), row(2, "assistant", "new")], {
      pageHasMore: false,
    });
    expect(changed.messages[0]).toBe(current[0]);
    expect(changed.messages[1].content).toBe("new");
    const same = reconcileTail(current, [row(1), row(2, "assistant", "old")], {
      pageHasMore: false,
    });
    expect(same.messages).toBe(current);
  });

  it("drops optimistic rows unless kept, appending kept ones last", () => {
    const current: ChatMessage[] = [
      row(1),
      { role: "user", content: "done", clientKey: "a" },
      { role: "user", content: "pending", clientKey: "b" },
    ];
    const { messages } = reconcileTail(current, [row(1), row(2, "user", "done")], {
      pageHasMore: false,
      keep: (m) => m.clientKey === "b",
    });
    expect(messages.map((m) => m.id ?? m.clientKey)).toEqual([1, 2, "b"]);
  });

  it("drops a kept optimistic user row the page already ends with", () => {
    const current: ChatMessage[] = [row(1), { role: "user", content: "hi", clientKey: "b" }];
    const { messages } = reconcileTail(
      current,
      [row(1), row(2, "user", "[app context: page /x]\nhi")],
      { pageHasMore: false, keep: () => true },
    );
    expect(messages.map((m) => m.id ?? m.clientKey)).toEqual([1, 2]);
  });
});

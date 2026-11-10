import { describe, expect, it } from "vitest";

import { activityText, chatTranscriptText } from "@/lib/chat/copy-chat";
import type { ChatMessage } from "@/types";

describe("chatTranscriptText", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Make a quote" },
    { role: "tool", content: "{\"ok\":true}" },
    { role: "assistant", content: "Here it is.", reasoning: "Check the template\nthen fill it" },
    { role: "assistant", content: "" },
  ];

  it("includes turns and saved reasoning, skips tool and empty rows", () => {
    const text = chatTranscriptText(messages, null, "Quote");
    expect(text).toBe(
      "# Quote\n\n---\n\n**You:**\n\nMake a quote\n\n---\n\n**Agent:**\n\nReasoning:\n> Check the template\n> then fill it\n\nHere it is.\n",
    );
  });

  it("appends the live activity of an in-flight turn", () => {
    const text = chatTranscriptText(messages, {
      tools: [
        { id: "a", name: "terminal", done: true },
        { id: "b", name: "vision_analyze", done: false },
      ],
      reasoning: "Workspace MCP found.",
    });
    expect(text).toContain(
      "**Agent activity (in progress):**\n\n- terminal — done\n- vision_analyze — running…\n\nReasoning:\n> Workspace MCP found.",
    );
  });

  it("omits an empty live activity", () => {
    expect(activityText({ tools: [], reasoning: "  " })).toBe("");
    expect(chatTranscriptText([], { tools: [], reasoning: "" })).toBe("\n");
  });
});

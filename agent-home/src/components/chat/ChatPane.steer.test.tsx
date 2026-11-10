// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPane } from "@/components/chat/ChatPane";
import { STEER_MARKER_CLOSE, STEER_MARKER_OPEN } from "@/lib/chat/transcript";
import type { ChatMessage } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const TRANSCRIPT: ChatMessage[] = [
  { id: 1, role: "user", content: "Build the Q2 report" },
  { id: 2, role: "assistant", content: "" },
  {
    id: 3,
    role: "tool",
    content: `TOOL-OUTPUT rows: 42\n\n${STEER_MARKER_OPEN}\nUse the Q3 numbers instead\n${STEER_MARKER_CLOSE}`,
  },
  { id: 4, role: "assistant", content: "Switched to the Q3 numbers." },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
  String(input).startsWith("/api/chat/messages")
    ? json({ session_id: "s1", messages: TRANSCRIPT })
    : json({}),
);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/chat?session=s1");
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

function bubbles() {
  return [...document.querySelectorAll("[data-component=MessageBubble]")].map((b) => [
    b.getAttribute("data-role"),
    b.firstElementChild?.textContent,
  ]);
}

describe("ChatPane — steers sent while the agent worked", () => {
  it("renders a delivered steer as the user's labelled bubble after that tool step", async () => {
    render(
      <ChatPane
        initialSessions={[]}
        initialSessionId="s1"
        initialMessages={TRANSCRIPT}
        storageEnabled={false}
        profile="default"
      />,
    );
    await waitFor(() =>
      expect(bubbles()).toEqual([
        ["user", "Build the Q2 report"],
        ["user", "Sent while workingUse the Q3 numbers instead"],
        ["assistant", "Switched to the Q3 numbers."],
      ]),
    );
    expect(screen.getAllByText("Sent while working")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("TOOL-OUTPUT");
    expect(document.body.textContent).not.toContain("OUT-OF-BAND");
  });
});

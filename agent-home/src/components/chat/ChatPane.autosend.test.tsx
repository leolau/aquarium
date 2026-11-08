// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPane } from "@/components/chat/ChatPane";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/chat?new=1&autosend=1&draft=hello&keep=1");
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("ChatPane auto-send hand-off", () => {
  it("drops the hand-off from the address bar so a reload cannot send the turn again", async () => {
    render(
      <ChatPane
        initialSessions={[]}
        initialSessionId={null}
        initialMessages={[]}
        storageEnabled={false}
        profile="default"
        initialDraft="hello"
        autoSend
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(window.location.pathname + window.location.search).toBe("/chat?keep=1");
  });
});

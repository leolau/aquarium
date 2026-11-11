// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLabChat, visibleTurns } from "@/components/skills/useLabChat";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const calls = (path: string) => fetchMock.mock.calls.filter(([u]) => String(u).split("?")[0] === path);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(save = vi.fn(async (draft: string, id: string | null) => ({ draft, id }))) {
  const onChanged = vi.fn();
  const hook = renderHook(() =>
    useLabChat({
      startUrl: "/api/lab/start",
      startBody: (goal) => ({ name: "x", project: "site", ...(goal ? { goal } : {}) }),
      messageUrl: "/api/lab/message",
      messageBody: { profile: "coder" },
      transcriptQuery: "profile=coder",
      seedStart: "SEED:",
      save,
      onChanged,
    }),
  );
  return { ...hook, save, onChanged };
}

describe("useLabChat", () => {
  it("starts the session lazily, reuses it, extracts the draft and saves it", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/lab/start") return json({ session_id: "s1" });
      return json({ reply: "Try this\n```skill-draft\nNEW\n```" });
    });
    const { result, save, onChanged } = setup();
    await act(() => result.current.send.run("first"));
    await act(() => result.current.send.run("second"));
    expect(calls("/api/lab/start")).toHaveLength(1);
    expect(bodyOf(calls("/api/lab/start")[0])).toEqual({ name: "x", project: "site" });
    expect(calls("/api/lab/message").map(bodyOf)).toEqual([
      { session_id: "s1", text: "first", profile: "coder" },
      { session_id: "s1", text: "second", profile: "coder" },
    ]);
    expect(result.current.draft).toBe("NEW");
    expect(result.current.turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const rev = result.current.draftRev;

    await act(() => result.current.save.run());
    expect(save).toHaveBeenCalledWith("NEW", "s1");
    expect(result.current.saved).toEqual({ draft: "NEW", id: "s1" });
    expect(onChanged).toHaveBeenCalled();
    expect(result.current.draftRev).toBe(rev);
  });

  it("keeps a failed message for retry and drops the optimistic turn", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/api/lab/start" ? json({ session_id: "s1" }) : json({ detail: "model down" }, 502),
    );
    const { result } = setup();
    await act(() => result.current.send.run("help"));
    expect(result.current.turns).toEqual([]);
    expect(result.current.sendError?.text).toBe("help");
    expect(result.current.sendError?.message).toContain("model down");
  });

  it("reopens a transcript without the hidden seed and with its last draft", async () => {
    fetchMock.mockImplementation(() =>
      json({
        messages: [
          { role: "user", content: "SEED: context\n\n## My message\nfix it" },
          { role: "assistant", content: "" },
          { role: "assistant", content: "```skill-draft\nOLD\n```" },
        ],
      }),
    );
    const { result } = setup();
    await act(() => result.current.openTranscript("s9"));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/chat/messages?sessionId=s9&visible=1&profile=coder");
    expect(result.current.sessionId).toBe("s9");
    expect(result.current.turns.map((t) => t.content)).toEqual(["fix it", "```skill-draft\nOLD\n```"]);
    expect(result.current.draft).toBe("OLD");
  });

  it("start() passes the goal and reports failures as a notice", async () => {
    fetchMock.mockImplementationOnce(() => json({ detail: "project not found" }, 404));
    const { result } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.start.run("  tidy  ");
    });
    expect(ok).toBe(false);
    expect(bodyOf(calls("/api/lab/start")[0])).toEqual({ name: "x", project: "site", goal: "tidy" });
    await waitFor(() => expect(result.current.notice).toContain("project not found"));
  });

  it("visibleTurns only strips a seeded first user turn", () => {
    expect(visibleTurns([{ role: "user", content: "plain" }], "SEED:")[0].content).toBe("plain");
  });
});

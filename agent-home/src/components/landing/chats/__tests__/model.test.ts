import { describe, expect, it } from "vitest";

import {
  displayTitle,
  matchesQuery,
  pinsSupported,
  quoteList,
  relativeTime,
  sessionMeta,
  splitSessions,
} from "../model";
import { NOW, sessions, withoutPins } from "./fixtures";

describe("chats model", () => {
  it("splits pinned (latest pin first) from recent (newest first) and drops archived", () => {
    const { pinned, recent } = splitSessions(sessions);
    expect(pinned.map((s) => s.id)).toEqual(["s-refactor", "s-q3"]);
    expect(recent.map((s) => s.id)).toEqual(["s-pricing", "s-untitled", "s-flaky", "s-onboarding"]);
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1].last_active!).toBeGreaterThanOrEqual(recent[i].last_active!);
    }
  });

  it("detects pin support from the presence of pinned_at", () => {
    expect(pinsSupported(sessions)).toBe(true);
    const legacy = withoutPins(sessions);
    expect(pinsSupported(legacy)).toBe(false);
  });

  it("shows the preview for untitled chats", () => {
    expect(displayTitle({ title: "  ", preview: "hello" })).toEqual({ text: "hello", untitled: true });
    expect(displayTitle({ title: null, preview: "" })).toEqual({ text: "New chat", untitled: true });
    expect(displayTitle({ title: "Plan", preview: "x" })).toEqual({ text: "Plan", untitled: false });
  });

  it("matches title, preview and tags case-insensitively", () => {
    const s = { ...sessions[3], tags: [{ id: 1, name: "Ops" }] } as never;
    expect(matchesQuery(s, "NIGHTLY")).toBe(true);
    expect(matchesQuery(s, "ops")).toBe(true);
    expect(matchesQuery(s, "billing")).toBe(false);
    expect(matchesQuery(s, "  ")).toBe(true);
  });

  it("formats relative times and meta", () => {
    expect(relativeTime(NOW / 1000 - 20, NOW)).toBe("just now");
    expect(relativeTime(NOW / 1000 - 14 * 60, NOW)).toBe("14 min ago");
    expect(relativeTime(NOW / 1000 - 3 * 3600, NOW)).toBe("3 h ago");
    expect(sessionMeta(sessions[2], "Default", NOW)).toBe("Default · working now");
    expect(sessionMeta(sessions[0], "work", NOW)).toBe("work · 14 min ago");
  });

  it("quotes suggestion names", () => {
    expect(quoteList(["A"])).toBe("“A”");
    expect(quoteList(["A", "B"])).toBe("“A” and “B”");
    expect(quoteList(["A", "B", "C"])).toBe("“A”, “B” and “C”");
  });
});

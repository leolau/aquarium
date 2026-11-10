import { describe, expect, it } from "vitest";

import {
  isUserStartedChat,
  latestSession,
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

  it("matches a chat ref exactly, case-insensitively", () => {
    const s = { ...sessions[0], ref: "C12" };
    expect(matchesQuery(s, "c12")).toBe(true);
    expect(matchesQuery(s, " C12 ")).toBe(true);
    expect(matchesQuery(s, "C1")).toBe(false);
    expect(matchesQuery(s, "C120")).toBe(false);
    expect(matchesQuery(sessions[0], "C12")).toBe(false);
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

describe("isUserStartedChat", () => {
  const base = { source: "agent_home", preview: "hi there", cwd: null };
  it("keeps Aquarium chats with a user message", () => {
    expect(isUserStartedChat(base)).toBe(true);
  });
  it.each([
    ["cron", { source: "cron" }],
    ["project run", { source: "projects:acme:run-2" }],
    ["to-do", { source: "todo" }],
    ["messaging channel", { source: "telegram" }],
    ["API server", { source: "api_server" }],
    ["kanban worker", { cwd: "/root/.hermes/kanban/workspaces/t_9" }],
    ["delivery topic without a user message", { preview: "" }],
  ])("drops a %s session", (_, over) => {
    expect(isUserStartedChat({ ...base, ...over })).toBe(false);
  });
});

describe("latestSession", () => {
  it("picks the chat touched last, skipping archived ones", () => {
    expect(latestSession(sessions)?.id).toBe("s-pricing");
    expect(latestSession([])).toBeNull();
  });
});

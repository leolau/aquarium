// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("@/lib/replace-location", () => ({ replaceLocation: (href: string) => replace(href) }));

import { leaveExpiredSession, resetExpiredSession } from "@/lib/auth/expired-session";

import { landingApi } from "./api";

afterEach(() => {
  resetExpiredSession();
  replace.mockReset();
  vi.restoreAllMocks();
});

function answer(status: number) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify({ error: "x" }), { status }));
}

describe("landingApi reads", () => {
  it.each([
    ["bar", () => landingApi.bar()],
    ["needs-you", () => landingApi.needsYou()],
    ["needs-you count", () => landingApi.needsYou({ countOnly: true })],
  ])("%s: a 401 signs the browser out to /login", async (_name, read) => {
    const fetchSpy = answer(401);

    expect(await read()).toBeNull();
    await leaveExpiredSession();

    expect(fetchSpy).toHaveBeenCalledWith("/api/session/logout", { method: "POST" });
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("a 502 keeps the last good data and stays on the page", async () => {
    answer(502);

    expect(await landingApi.bar()).toBeNull();

    expect(replace).not.toHaveBeenCalled();
  });
});

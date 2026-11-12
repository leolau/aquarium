// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("@/lib/replace-location", () => ({ replaceLocation: (href: string) => replace(href) }));

import { leaveExpiredSession, resetExpiredSession, signedOut } from "./expired-session";

afterEach(() => {
  resetExpiredSession();
  replace.mockReset();
  vi.restoreAllMocks();
});

const logoutCalls = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([url]: unknown[]) => url === "/api/session/logout");

describe("expired session", () => {
  it("clears the cookie before loading /login, so /login cannot bounce back to /", async () => {
    let clearedBeforeRedirect = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    replace.mockImplementation(() => {
      clearedBeforeRedirect = logoutCalls(fetchSpy).length === 1;
    });

    expect(signedOut(new Response("", { status: 401 }))).toBe(true);
    await leaveExpiredSession();

    expect(fetchSpy).toHaveBeenCalledWith("/api/session/logout", { method: "POST" });
    expect(replace).toHaveBeenCalledWith("/login");
    expect(clearedBeforeRedirect).toBe(true);
  });

  it("signs out once however many polls see the 401", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    signedOut(new Response("", { status: 401 }));
    signedOut(new Response("", { status: 401 }));
    await leaveExpiredSession();

    expect(logoutCalls(fetchSpy)).toHaveLength(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("still goes to /login when the cookie clear itself fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));

    await leaveExpiredSession();

    expect(replace).toHaveBeenCalledWith("/login");
  });

  it.each([200, 403, 404, 502])("leaves a %i alone", (status) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(signedOut(new Response("", { status }))).toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

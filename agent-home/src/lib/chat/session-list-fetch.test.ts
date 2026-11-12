// @vitest-environment jsdom
/**
 * The session-list coalescer: passive readers share an in-flight request or
 * a just-finished one; `force` (post-mutation) always issues a fresh fetch
 * that later readers then join. Failures never erase the last good data.
 */
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("@/lib/replace-location", () => ({ replaceLocation: (href: string) => replace(href) }));

import { leaveExpiredSession, resetExpiredSession } from "@/lib/auth/expired-session";
import { fetchSessionList } from "@/lib/chat/session-list-fetch";

let n = 0;
const url = () => `/api/chat/sessions?limit=200&t=${(n += 1)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchReturning(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchSessionList", () => {
  it("joins concurrent callers onto one request", async () => {
    const u = url();
    const fetchMock = fetchReturning({ sessions: [{ id: "s1" }] });
    const [a, b, c] = await Promise.all([
      fetchSessionList(u),
      fetchSessionList(u),
      fetchSessionList(u),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a?.sessions?.[0].id).toBe("s1");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("reuses a result that just landed (the resume burst case)", async () => {
    const u = url();
    const fetchMock = fetchReturning({ sessions: [] });
    await fetchSessionList(u);
    const again = await fetchSessionList(u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again?.sessions).toEqual([]);
  });

  it("force always fetches — a post-mutation read must see the change", async () => {
    const u = url();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: "old" }] }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: "new" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSessionList(u);
    const fresh = await fetchSessionList(u, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh?.sessions?.[0].id).toBe("new");
  });

  it("a failed refresh keeps the last good data for later readers", async () => {
    const u = url();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: "good" }] }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const good = await fetchSessionList(u);
    const failed = await fetchSessionList(u, { force: true });
    expect(failed).toBeNull();
    // …and a passive reader after the failure still sees the good snapshot.
    const later = await fetchSessionList(u);
    expect(later?.sessions?.[0].id).toBe(good?.sessions?.[0].id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("different URLs never share a request", async () => {
    const a = url();
    const b = url();
    const fetchMock = fetchReturning({ sessions: [] });
    await Promise.all([fetchSessionList(a), fetchSessionList(b)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchSessionList on an expired login", () => {
  it("a 401 resolves null and signs the browser out to /login", async () => {
    resetExpiredSession();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ error: "unauthenticated" }, 401));

    expect(await fetchSessionList(url())).toBeNull();
    await leaveExpiredSession();

    expect(fetchSpy).toHaveBeenCalledWith("/api/session/logout", { method: "POST" });
    expect(replace).toHaveBeenCalledWith("/login");
    fetchSpy.mockRestore();
    resetExpiredSession();
  });
});

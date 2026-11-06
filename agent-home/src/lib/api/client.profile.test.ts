import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HermesApiClient, isBoxWidePath } from "@/lib/api/client";

afterEach(() => {
  vi.restoreAllMocks();
});

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sse() {
  return new Response("event: assistant.completed\ndata: {}\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function bound() {
  return new HermesApiClient({
    hermesToken: "tok",
    baseUrl: "http://api.test",
    profile: "maintenance",
  });
}

describe("HermesApiClient profile binding (FG-28)", () => {
  it("scopes reads by query so the list comes from that profile's store", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(ok({ sessions: [], total: 0, limit: 30, offset: 0 }));

    await bound().sessions({ source: "agent_home" });

    expect(String(fetchMock.mock.calls[0][0])).toContain("profile=maintenance");
  });

  it("scopes a turn by body so the requested profile's brain answers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(ok({ session_id: "s1", message: {} }));

    await bound().sendChat("s1", "hello");

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ message: "hello", profile: "maintenance" });
  });

  it("scopes a streamed turn too — streams bypass the request wrapper", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse());

    await bound().openChatStream("s1", "hello");

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ message: "hello", profile: "maintenance" });
  });

  it("leaves a single-profile deployment's requests untouched", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(ok({ session_id: "s1", message: {} }));

    // An explicit "default" is the box's own home, so it must not be sent —
    // otherwise every ordinary request looks like a cross-profile one.
    const client = new HermesApiClient({
      baseUrl: "http://api.test",
      profile: "default",
    });
    expect(client.boundProfile()).toBeUndefined();
    await client.sendChat("s1", "hello");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("profile=");
    expect(JSON.parse(String(init?.body))).toEqual({ message: "hello" });
  });

  it("never scopes a box-wide route — it describes the machine, not a profile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ok({}));
    const client = bound();

    await client.capacity();
    await client.systemStats();
    await client.browsePlaces();
    await client.browseSave("home", "a.txt");
    await client.request("/api/files/list?path=x");
    await client.request("/api/quotas/box");

    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("profile=");
      if (init?.body) expect(JSON.parse(String(init.body))).not.toHaveProperty("profile");
    }
  });

  it("tells box-wide paths from profile-scoped look-alikes", () => {
    for (const p of ["/api/files", "/api/fs/read?p=1", "/api/browse/list", "/api/capacity/upload-storage", "/api/system/stats", "/api/quotas/box"]) {
      expect(isBoxWidePath(p), p).toBe(true);
    }
    for (const p of ["/api/filesystem", "/api/system/other", "/api/quotas", "/api/quotas/me", "/api/sessions"]) {
      expect(isBoxWidePath(p), p).toBe(false);
    }
  });

  it("leaves unscoped every route Python refuses to scope (BOX_WIDE_PREFIXES)", () => {
    const py = readFileSync(
      path.resolve(__dirname, "../../../../hermes_cli/profile_route_scope.py"),
      "utf8",
    );
    const block = /BOX_WIDE_PREFIXES = \(([\s\S]*?)\)/.exec(py)?.[1] ?? "";
    const prefixes = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) {
      expect(isBoxWidePath(prefix), prefix).toBe(true);
      expect(isBoxWidePath(`${prefix}/x?y=1`), prefix).toBe(true);
    }
  });
});

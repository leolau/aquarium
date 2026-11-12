/**
 * FG-23 §7 — memory client methods: forwarded path + query string, the bridged
 * token is sent as both `cookie: hermes_session_at=` and `authorization:
 * Bearer`, and `mode` never appears in any memory URL (D3).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HermesApiClient, ownersParam } from "@/lib/api/client";

function mockFetch(status = 200, body: unknown = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }));
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

describe("HermesApiClient memory methods", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const token = "test-hermes-token";

  function makeClient(): { client: HermesApiClient; fetchFn: ReturnType<typeof vi.fn> } {
    const fetchFn = mockFetch(200, { ok: true });
    const client = new HermesApiClient({ hermesToken: token, baseUrl: "http://api.test" });
    return { client, fetchFn };
  }

  it("memorySummary GETs /api/memory/explorer/summary with no mode", async () => {
    const { client, fetchFn } = makeClient();
    await client.memorySummary();
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("/api/memory/explorer/summary");
    expect(url).not.toContain("mode=");
  });

  it("memoryRows forwards q, topic, kind, limit, offset", async () => {
    const { client, fetchFn } = makeClient();
    await client.memoryRows({ q: "hello", topic: "work", kind: "memory", limit: 10, offset: 20 });
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("q=hello");
    expect(url).toContain("topic=work");
    expect(url).toContain("kind=memory");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=20");
    expect(url).not.toContain("mode=");
  });

  it("memoryRows defaults to limit=25 and offset=0", async () => {
    const { client, fetchFn } = makeClient();
    await client.memoryRows();
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=0");
  });

  it("memoryProjection GETs /api/memory/explorer/projection with optional limit", async () => {
    const { client, fetchFn } = makeClient();
    await client.memoryProjection(1000);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("/api/memory/explorer/projection");
    expect(url).toContain("limit=1000");
    expect(url).not.toContain("mode=");
  });

  it("memoryRows and memoryProjection send owners= as one comma list", async () => {
    const { client, fetchFn } = makeClient();
    await client.memoryRows({ owners: ["ada", "bob"] });
    await client.memoryProjection(undefined, ["ada"]);
    await client.files({ owners: ["ada", "bob"] });
    await client.incomings({ owners: ["bob"] });
    const urls = fetchFn.mock.calls.map((call) => call[0] as string);
    expect(urls[0]).toContain("owners=ada%2Cbob");
    expect(urls[1]).toContain("/api/memory/explorer/projection?owners=ada");
    expect(urls[2]).toContain("owners=ada%2Cbob");
    expect(urls[3]).toContain("owners=bob");
    expect(ownersParam(" ada, ,bob ")).toEqual(["ada", "bob"]);
    expect(ownersParam(null)).toBeUndefined();
  });

  it("memoryProjection omits limit when not specified", async () => {
    const { client, fetchFn } = makeClient();
    await client.memoryProjection();
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).not.toContain("limit=");
    expect(url).not.toContain("mode=");
  });

  it("memoryQuery POSTs { text } to /api/memory/explorer/projection/query", async () => {
    const { client, fetchFn } = makeClient();
    await client.memoryQuery("what is hermes?");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/api/memory/explorer/projection/query");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("what is hermes?");
    expect(body).not.toHaveProperty("mode");
  });

  it("memoryDocuments GETs /api/memory/explorer/documents with no mode", async () => {
    const { client, fetchFn } = makeClient();
    await client.memoryDocuments();
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain("/api/memory/explorer/documents");
    expect(url).not.toContain("mode=");
  });

  it("sends the bridged token as both cookie and bearer", async () => {
    const { client, fetchFn } = makeClient();
    await client.memorySummary();
    const headers = fetchFn.mock.calls[0][1].headers as Headers;
    expect(headers.get("cookie")).toBe(`hermes_session_at=${token}`);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});

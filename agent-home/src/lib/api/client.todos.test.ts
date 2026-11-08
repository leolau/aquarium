/**
 * API client tests for the to-do methods.
 *
 * Mocks `globalThis.fetch` to pin the URL, method and body of each call: the
 * client is a URL builder, so the querystring *is* the behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HermesApiClient } from "@/lib/api/client";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fresh 200 per call: a `Response` body can only be read once. */
function ok(body: unknown) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

function client() {
  return new HermesApiClient({ baseUrl: "http://api.test" });
}

describe("HermesApiClient to-dos", () => {
  it("todos sends only the filters that were set", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(ok({ items: [], next_cursor: null }));

    await client().todos({ stage: "staged,open", priority: "high" });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/registry/todos");
    expect(url.searchParams.get("stage")).toBe("staged,open");
    expect(url.searchParams.get("priority")).toBe("high");
    expect(url.searchParams.get("limit")).toBe("50");
    // An unset filter is absent, not empty: `q=` would mean "search for
    // nothing" to a route that treats the parameter as present.
    expect(url.searchParams.has("q")).toBe(false);
  });

  it("todos asks for snoozed rows only when told to", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(ok({ items: [], next_cursor: null }));

    await client().todos({});
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("include_snoozed");

    await client().todos({ include_snoozed: true });
    expect(String(fetchMock.mock.calls[1][0])).toContain("include_snoozed=true");
  });

  it("todo, facets and stage hit their own routes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(ok({}));
    const c = client();

    await c.todosFacets();
    await c.todo("tsk 1");
    await c.setTodoStage("tsk 1", "done", "sent the quote");

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe("http://api.test/api/registry/todos/facets");
    // Ids are opaque and go in the path, so they are encoded, not interpolated.
    expect(urls[1]).toBe("http://api.test/api/registry/todos/tsk%201");
    expect(urls[2]).toBe("http://api.test/api/registry/todos/tsk%201/stage");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      stage: "done",
      outcome: "sent the quote",
    });
  });

  it("createTodo POSTs the whole to-do", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(ok({}));

    await client().createTodo({ title: "Call the bank", priority: "high" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://api.test/api/registry/todos");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Call the bank",
      priority: "high",
    });
  });

  it("updateTodo PATCHes and snoozeTodo carries the end time", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(ok({}));
    const c = client();

    await c.updateTodo("t1", { title: "Renamed" });
    await c.snoozeTodo("t1", "2026-08-20T09:00:00Z");

    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      title: "Renamed",
    });
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "http://api.test/api/registry/todos/t1/snooze",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      until: "2026-08-20T09:00:00Z",
    });
  });

  it("unsnoozeTodo POSTs the state to restore", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(ok({}));
    const c = client();

    await c.unsnoozeTodo("t1", { until: null, notified_at: "2026-08-11T09:00:00Z" });
    await c.unsnoozeTodo("t1");

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://api.test/api/registry/todos/t1/unsnooze",
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      until: null,
      notified_at: "2026-08-11T09:00:00Z",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({});
  });

  it("completeTodo carries the outcome and the drafted action", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(ok({}));

    await client().completeTodo("t1", {
      outcome: "sent the quote",
      // No channel or target: the reply route is the server's to resolve from
      // the arrival (C4), so the client only ever sends the words.
      proposed_action: { body: "Quote attached.", subject: "Re: tender" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://api.test/api/registry/todos/t1/complete",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      outcome: "sent the quote",
      proposed_action: { body: "Quote attached.", subject: "Re: tender" },
    });
  });

  it("completeTodo finishes with no proposal when nothing was drafted", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(ok({}));

    await client().completeTodo("t1");

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({});
  });
});

// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TodosList } from "@/components/todos/TodosList";
import type { Todo, TodosFacets } from "@/types";

const BASE: Todo = {
  id: "tsk_1",
  owner_user_id: "leo_owner",
  visibility: "private:leo_owner",
  title: "Send Ada the signed quote",
  description: "The tender closes on Friday.",
  stage: "open",
  status: "pending",
  priority: "high",
  origin: "triage",
  current_state: "captured",
  trigger_state: "captured",
  completion_state: "done",
  due_at: null,
  source_kind: "inbound",
  source_ref: "inb_1",
  source_note: null,
  notified_at: null,
  snoozed_until: null,
  closed_at: null,
  outcome: null,
  created_at: null,
  updated_at: null,
};

const FACETS: TodosFacets = {
  stages: [
    { value: "staged", count: 4 },
    { value: "open", count: 2 },
  ],
  priorities: [{ value: "high", count: 2 }],
  source_kinds: [{ value: "inbound", count: 6 }],
};


class FakeObserver {
  static all: FakeObserver[] = [];
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe() {}
  disconnect() {}
  fire() {
    this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeObserver.all = [];
});

describe("TodosList infinite scroll", () => {
  it("fetches the next page once even when the sentinel fires repeatedly", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    render(<TodosList initial={{ items: [BASE], next_cursor: "cur_2" }} facets={FACETS} />);
    const observer = FakeObserver.all.at(-1)!;
    act(() => {
      observer.fire();
      observer.fire();
      observer.fire();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("cur_2");
  });
});

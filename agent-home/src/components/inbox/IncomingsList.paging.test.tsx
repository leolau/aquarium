// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IncomingsList } from "@/components/inbox/IncomingsList";
import type { IncomingItem, IncomingsFacets } from "@/types";

const BASE: IncomingItem = {
  id: "inb_1",
  owner_user_id: "leo_owner",
  visibility: "private:leo_owner",
  surface: "whatsapp",
  account_id: "+85211112222",
  external_id: "wamid.1",
  kind: "message",
  conversation: "group:tender",
  conversation_name: null,
  sender_id: "+85233334444",
  sender_name: "Ada",
  subject: null,
  body: "the tender is due friday",
  occurred_at: new Date().toISOString(),
  ends_at: null,
  registered_at: null,
  importance: null,
  has_attachments: false,
  metadata: {},
  document_id: null,
  remembered_at: null,
  remembered_by: null,
  remembered: false,
};

const FACETS: IncomingsFacets = {
  surfaces: [
    { value: "whatsapp", count: 2 },
    { value: "email", count: 5 },
  ],
  importance: [],
  tags: [{ id: "tag_1", name: "finance", color: "green" }],
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

describe("IncomingsList infinite scroll", () => {
  it("fetches the next page once even when the sentinel fires repeatedly", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    render(<IncomingsList initial={{ items: [BASE], next_cursor: "cur_2" }} facets={FACETS} />);
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

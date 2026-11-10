import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { IncomingRow, excerpt, relativeWhen, timeRange } from "@/components/inbox/IncomingRow";
import { IncomingsList } from "@/components/inbox/IncomingsList";
import {
  EMPTY_FILTERS,
  filtersFromParams,
  filtersToParams,
} from "@/components/inbox/IncomingsFilters";
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

describe("IncomingRow", () => {
  it("titles a chat message by its sender, since it has no subject", () => {
    const html = renderToStaticMarkup(<IncomingRow item={BASE} />);
    expect(html).toContain('data-component="IncomingRow"');
    expect(html).toContain("Ada");
    expect(html).toContain("the tender is due friday");
    expect(html).toContain("/inbox/inb_1");
  });

  it("shows an email's subject with the sender demoted to the meta line", () => {
    const html = renderToStaticMarkup(
      <IncomingRow
        item={{ ...BASE, surface: "email", subject: "Invoice 42" }}
      />,
    );
    expect(html).toContain("Invoice 42");
    expect(html).toContain("Ada");
  });

  it("marks attachments, triage importance and remembered state", () => {
    const html = renderToStaticMarkup(
      <IncomingRow
        item={{
          ...BASE,
          has_attachments: true,
          importance: "urgent",
          remembered: true,
          tags: [{ id: "tag_1", name: "finance", color: "green" }],
        }}
      />,
    );
    expect(html).toContain("📎");
    expect(html).toContain("urgent");
    expect(html).toContain("remembered");
    expect(html).toContain("finance");
  });

  it("shows a meeting's time range, which a message does not have", () => {
    const event = {
      ...BASE,
      surface: "calendar",
      kind: "event",
      subject: "Standup",
      occurred_at: "2026-08-11T01:00:00+00:00",
      ends_at: "2026-08-11T01:15:00+00:00",
    };
    expect(timeRange(event)).toContain("–");
    expect(timeRange(BASE)).toBe("");
  });
});

describe("IncomingsList", () => {
  it("renders the server's first page with the channel chips", () => {
    const html = renderToStaticMarkup(
      <IncomingsList
        initial={{ items: [BASE], next_cursor: "cur_1" }}
        facets={FACETS}
      />,
    );
    expect(html).toContain('data-component="IncomingsList"');
    expect(html).toContain('data-component="IncomingsFilters"');
    expect(html).toContain("WhatsApp · 2");
    expect(html).toContain("Email · 5");
    expect(html).toContain("the tender is due friday");
    // A cursor means there is more, so the fallback control must be offered.
    expect(html).toContain("Load more");
  });

  it("explains an empty inbox rather than showing a bare list", () => {
    const html = renderToStaticMarkup(
      <IncomingsList
        initial={{ items: [], next_cursor: null }}
        facets={{ surfaces: [], importance: [], tags: [] }}
      />,
    );
    expect(html).toContain('data-component="IncomingsEmpty"');
    expect(html).toContain("Nothing has arrived yet");
  });
});

describe("filter URL round trip", () => {
  it("restores exactly what it wrote", () => {
    const filters = {
      ...EMPTY_FILTERS,
      q: "invoice",
      surfaces: ["email", "whatsapp"],
      includeTags: ["finance"],
      excludeTags: ["spam"],
      tagMatch: "all" as const,
      hasAttachments: true,
      remembered: false,
      since: "2026-08-01",
    };
    expect(filtersFromParams(filtersToParams(filters))).toEqual(filters);
  });

  it("keeps the cursor out of the shared URL", () => {
    // A shared inbox link is a shared *filter*; carrying somebody else's
    // scroll position would drop the reader into the middle of the list.
    const shareable = filtersToParams({ ...EMPTY_FILTERS, q: "invoice" });
    expect(shareable.has("cursor")).toBe(false);
    const fetched = filtersToParams({ ...EMPTY_FILTERS, q: "invoice" }, "cur_1");
    expect(fetched.get("cursor")).toBe("cur_1");
  });
});

describe("relativeWhen", () => {
  it("counts up in the units a reader actually scans by", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(relativeWhen(ago(10_000))).toBe("now");
    expect(relativeWhen(ago(5 * 60_000))).toBe("5m");
    expect(relativeWhen(ago(3 * 3_600_000))).toBe("3h");
    expect(relativeWhen(ago(2 * 86_400_000))).toBe("2d");
    expect(relativeWhen(null)).toBe("");
  });
});

describe("excerpt", () => {
  it("collapses whitespace and clips, so one row stays one row", () => {
    expect(excerpt({ ...BASE, body: "a\n\n  b" })).toBe("a b");
    expect(excerpt({ ...BASE, body: "x".repeat(200) })).toHaveLength(140);
  });
});

describe("short refs (FG-36)", () => {
  it("shows an arrival's ref on its row", () => {
    const row = renderToStaticMarkup(<IncomingRow item={{ ...BASE, ref: "M512" }} />);
    expect(row).toContain('data-component="RefBadge"');
    expect(row).toContain('data-ref="M512"');
    expect(renderToStaticMarkup(<IncomingRow item={BASE} />)).not.toContain("RefBadge");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TodoRow, dueLabel, excerpt } from "@/components/todos/TodoRow";
import { TodosList } from "@/components/todos/TodosList";
import { TodoDetailView } from "@/components/todos/TodoDetailView";
import {
  DEFAULT_STAGES,
  EMPTY_FILTERS,
  filtersFromParams,
  filtersToParams,
} from "@/components/todos/filters";
import type { Todo, TodoDetail, TodosFacets } from "@/types";

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
  work_result: null,
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

describe("TodoRow", () => {
  it("shows the to-do, its stage, its priority and where it came from", () => {
    const html = renderToStaticMarkup(<TodoRow todo={BASE} />);
    expect(html).toContain('data-component="TodoRow"');
    expect(html).toContain("Send Ada the signed quote");
    expect(html).toContain("The tender closes on Friday.");
    expect(html).toContain("/todos/tsk_1");
    expect(html).toContain("Open");
    expect(html).toContain("high");
    expect(html).toContain("from triage");
  });

  it("offers 'Open it' on a staged to-do and 'Work on it' once it is open", () => {
    const staged = renderToStaticMarkup(
      <TodoRow todo={{ ...BASE, stage: "staged" }} onStage={() => {}} />,
    );
    expect(staged).toContain("Open it");
    expect(staged).not.toContain("Work on it");

    const open = renderToStaticMarkup(<TodoRow todo={BASE} onStage={() => {}} />);
    expect(open).toContain("Work on it");
    expect(open).not.toContain("Open it");
  });

  it("offers nothing to change on a closed to-do", () => {
    const html = renderToStaticMarkup(
      <TodoRow todo={{ ...BASE, stage: "done" }} onStage={() => {}} />,
    );
    expect(html).not.toContain("<button");
  });

  it("reads a due date as a distance, because that is the decision", () => {
    const day = 86_400_000;
    expect(dueLabel(new Date(Date.now() - day).toISOString())).toBe("overdue");
    expect(dueLabel(new Date(Date.now() + 3_600_000).toISOString())).toBe("today");
    expect(dueLabel(new Date(Date.now() + 3 * day).toISOString())).toBe("in 3d");
    expect(dueLabel(null)).toBe("");
    expect(dueLabel("not a date")).toBe("");
  });

  it("collapses whitespace and truncates the excerpt", () => {
    expect(excerpt("  a\n\n  b  ")).toBe("a b");
    expect(excerpt("x".repeat(200))).toHaveLength(140);
  });
});

describe("TodosFilters URL round-trip", () => {
  it("defaults to the live stages, so closed work does not fill the list", () => {
    expect(filtersFromParams(new URLSearchParams()).stages).toEqual(
      DEFAULT_STAGES,
    );
    expect(DEFAULT_STAGES).not.toContain("done");
  });

  it("restores a shared filter URL exactly", () => {
    const params = new URLSearchParams(
      "q=quote&stage=open,working&priority=high&include_snoozed=true&source_ref=inb_1",
    );
    const state = filtersFromParams(params);
    expect(state).toEqual({
      q: "quote",
      stages: ["open", "working"],
      priorities: ["high"],
      sourceRef: "inb_1",
      includeSnoozed: true,
    });
    // Round-trips: the same state produces the same querystring back.
    expect(filtersToParams(state).get("stage")).toBe("open,working");
    expect(filtersToParams(state).get("include_snoozed")).toBe("true");
  });

  it("keeps the cursor out of the shareable filter", () => {
    const withCursor = filtersToParams(EMPTY_FILTERS, "cur_2");
    expect(withCursor.get("cursor")).toBe("cur_2");
    expect(filtersToParams(EMPTY_FILTERS).has("cursor")).toBe(false);
  });
});

describe("TodosList", () => {
  it("renders the server's first page with its filters", () => {
    const html = renderToStaticMarkup(
      <TodosList
        initial={{ items: [BASE], next_cursor: "cur_2" }}
        facets={FACETS}
      />,
    );
    expect(html).toContain('data-component="TodosList"');
    expect(html).toContain('data-component="TodosFilters"');
    expect(html).toContain("Send Ada the signed quote");
    // The facet counts are on the stage chips.
    expect(html).toContain("Staged 4");
  });

  it("says what the page is for when there is nothing in it", () => {
    const html = renderToStaticMarkup(
      <TodosList initial={{ items: [], next_cursor: null }} facets={FACETS} />,
    );
    expect(html).toContain('data-component="TodosEmpty"');
    expect(html).toContain("anything that looks like it needs you");
  });
});

const DETAIL: TodoDetail = {
  ...BASE,
  history: [
    {
      from: "stage:staged",
      to: "stage:open",
      at: "2026-08-11T09:00:00+00:00",
      actor: "skill:email-triage",
    },
  ],
  source: {
    id: "inb_1",
    owner_user_id: "leo_owner",
    visibility: "private:leo_owner",
    surface: "email",
    account_id: "leo@example.com",
    external_id: "<abc@mail>",
    kind: "message",
    conversation: null,
    conversation_name: null,
    sender_id: "ada@example.com",
    sender_name: "Ada",
    subject: "Invoice 42",
    body: "the tender is due friday",
    occurred_at: "2026-08-10T08:00:00+00:00",
    ends_at: null,
    registered_at: null,
    importance: null,
    has_attachments: false,
    metadata: {},
    document_id: null,
    remembered_at: null,
    remembered_by: null,
    remembered: false,
  },
};

describe("TodoDetailView", () => {
  it("quotes the arrival that caused it, not just a link to it", () => {
    const html = renderToStaticMarkup(<TodoDetailView todo={DETAIL} />);
    expect(html).toContain('data-component="TodoSource"');
    expect(html).toContain("Invoice 42");
    expect(html).toContain("the tender is due friday");
    expect(html).toContain("/inbox/inb_1");
  });

  it("falls back to the note when the arrival is not linked", () => {
    const html = renderToStaticMarkup(
      <TodoDetailView
        todo={{
          ...DETAIL,
          source: null,
          source_ref: null,
          source_note: "whatsapp:+85233334444",
        }}
      />,
    );
    expect(html).toContain('data-component="TodoSourceNote"');
    expect(html).toContain("whatsapp:+85233334444");
  });

  it("shows who moved it, so agent and user stay distinguishable", () => {
    const html = renderToStaticMarkup(<TodoDetailView todo={DETAIL} />);
    expect(html).toContain('data-component="TodoHistory"');
    expect(html).toContain("skill:email-triage");
    expect(html).toContain("stage:staged");
  });

  // The outgoing seam's only user surface. It must read as "propose", never
  // as "send": what it produces is an approval the user still has to answer.
  it("offers to finish, and only proposes a reply when there is an arrival", () => {
    const withSource = renderToStaticMarkup(<TodoDetailView todo={DETAIL} />);
    expect(withSource).toContain('data-component="TodoCompleteForm"');
    expect(withSource).toContain("Mark done…");
    // The stage buttons must not offer a second, silent way to finish; the
    // phone dock's "Mark done" only opens the same form in a sheet.
    const rail = withSource.slice(
      withSource.indexOf('data-component="TodoActions"'),
      withSource.indexOf("</aside>"),
    );
    expect(rail).not.toContain(">Mark done<");
    expect(withSource).toMatch(/data-action="mark-done"[^>]*>Mark done</);
  });

  it("does not offer to finish a to-do that is already closed", () => {
    const html = renderToStaticMarkup(
      <TodoDetailView todo={{ ...DETAIL, stage: "dismissed" }} />,
    );
    expect(html).not.toContain('data-component="TodoCompleteForm"');
  });

  it("offers a snooze while the to-do is still waiting, not after", () => {
    expect(renderToStaticMarkup(<TodoDetailView todo={DETAIL} />)).toContain(
      "Snooze",
    );
    expect(
      renderToStaticMarkup(
        <TodoDetailView todo={{ ...DETAIL, stage: "done" }} />,
      ),
    ).not.toContain("Snooze");
  });
});

describe("short refs (FG-36)", () => {
  it("shows a to-do's ref on its row and detail page", () => {
    const row = renderToStaticMarkup(<TodoRow todo={{ ...BASE, ref: "D88" }} />);
    expect(row).toContain('data-component="RefBadge"');
    expect(row).toContain('data-ref="D88"');
    const detail = renderToStaticMarkup(
      <TodoDetailView todo={{ ...DETAIL, ref: "D88" }} />,
    );
    expect(detail).toContain('data-ref="D88"');
  });

  it("renders no badge for a backend that sends no ref", () => {
    expect(renderToStaticMarkup(<TodoRow todo={BASE} />)).not.toContain("RefBadge");
  });
});

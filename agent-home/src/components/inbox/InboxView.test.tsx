import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalsList } from "@/components/inbox/ApprovalsList";
import { ChangesList } from "@/components/inbox/ChangesList";
import { InboxView } from "@/components/inbox/InboxView";
import type {
  Change,
  IncomingItem,
  IncomingsFacets,
  IncomingsResponse,
  Notification,
} from "@/types";

const APPROVAL: Notification = {
  id: "ntf_1",
  kind: "approval",
  owner_user_id: "leo_owner",
  visibility: "private:leo_owner",
  title: "Run rm -rf build/",
  body: "The agent wants to clear the build dir.",
  command: "rm -rf build/",
  reversible: false,
  status: "pending",
  answer: null,
  answered_by: null,
  answered_via: null,
  delivered: true,
  created_at: null,
  answered_at: null,
};

const ANSWERED_ASK: Notification = {
  ...APPROVAL,
  id: "ntf_2",
  kind: "ask",
  title: "Ready to deploy?",
  reversible: true,
  status: "answered",
  answer: "acknowledged",
  answered_via: "telegram",
};

const REVERSIBLE: Change = {
  id: "chg_1",
  actor_user_id: "leo_owner",
  mode: "prod",
  target_kind: "memory",
  reversible: true,
  visibility: "private:leo_owner",
  undone: false,
};

const UNDONE: Change = { ...REVERSIBLE, id: "chg_2", undone: true };
const IRREVERSIBLE: Change = {
  ...REVERSIBLE,
  id: "chg_3",
  reversible: false,
  target_kind: "tool",
};

const ARRIVAL: IncomingItem = {
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
  body: "請問明天的會議改到下午三點嗎",
  occurred_at: "2026-08-10T09:30:00+00:00",
  ends_at: null,
  registered_at: "2026-08-10T09:30:01+00:00",
  importance: "urgent",
  has_attachments: false,
  metadata: {},
  document_id: null,
  remembered_at: null,
  remembered_by: null,
  remembered: false,
};

const INCOMINGS: IncomingsResponse = {
  items: [ARRIVAL],
  next_cursor: null,
};

const FACETS: IncomingsFacets = {
  surfaces: [{ value: "whatsapp", count: 1 }],
  importance: [{ value: "urgent", count: 1 }],
  tags: [],
};

describe("InboxView", () => {
  it("leads with Incomings — the tab that has traffic every day", () => {
    const html = renderToStaticMarkup(
      <InboxView
        initialConfigured
        initialNotifications={[APPROVAL]}
        initialChanges={[REVERSIBLE]}
        initialIncomings={INCOMINGS}
        incomingsFacets={FACETS}
      />,
    );
    expect(html).toContain('data-component="InboxView"');
    expect(html).toContain('data-component="IncomingsList"');
    expect(html).not.toContain("principal-scoped (C2)");
    expect(html).toContain("Arrived");
    expect(html).toContain("Approvals");
    expect(html).toContain("Changes");
    // The arrival itself, in Chinese, unsegmented.
    expect(html).toContain("請問明天的會議改到下午三點嗎");
    // The other tabs are not rendered until selected.
    expect(html).not.toContain('data-component="ApprovalsList"');
  });

  it("honours a deep link to another tab", () => {
    const html = renderToStaticMarkup(
      <InboxView
        initialConfigured
        initialNotifications={[APPROVAL]}
        initialChanges={[REVERSIBLE]}
        initialIncomings={INCOMINGS}
        incomingsFacets={FACETS}
        initialTab="approvals"
      />,
    );
    expect(html).toContain('data-component="ApprovalsList"');
    expect(html).toContain("Run rm -rf build/");
  });

  it("shows the unconfigured datastore state", () => {
    const html = renderToStaticMarkup(
      <InboxView
        initialConfigured={false}
        initialNotifications={[]}
        initialChanges={[]}
        initialIncomings={{ items: [], next_cursor: null }}
        incomingsFacets={{ surfaces: [], importance: [], tags: [] }}
      />,
    );
    expect(html).toContain("multi-user datastore configured");
  });
});

describe("ApprovalsList", () => {
  it("offers Approve/Deny on a pending approval and marks it irreversible", () => {
    const html = renderToStaticMarkup(
      <ApprovalsList notifications={[APPROVAL]} busyId={null} onAnswer={() => {}} />,
    );
    expect(html).toContain('data-component="ApprovalsList"');
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("irreversible");
    expect(html).toContain("rm -rf build/");
  });

  it("shows a settled ask with its cross-surface answer and no buttons", () => {
    const html = renderToStaticMarkup(
      <ApprovalsList
        notifications={[ANSWERED_ASK]}
        busyId={null}
        onAnswer={() => {}}
      />,
    );
    expect(html).toContain("acknowledged");
    expect(html).toContain("via telegram");
    expect(html).not.toContain(">Acknowledge<");
  });

  it("renders an empty state", () => {
    const html = renderToStaticMarkup(
      <ApprovalsList notifications={[]} busyId={null} onAnswer={() => {}} />,
    );
    expect(html).toContain("No pending approvals or asks");
  });
});

describe("ChangesList", () => {
  it("offers Undo on a live reversible change and Redo on an undone one", () => {
    const html = renderToStaticMarkup(
      <ChangesList
        changes={[REVERSIBLE, UNDONE]}
        busyId={null}
        onOp={() => {}}
      />,
    );
    expect(html).toContain('data-component="ChangesList"');
    expect(html).toContain("Undo");
    expect(html).toContain("Redo");
    expect(html).toContain("undone");
  });

  it("shows an irreversible change as review-only with no action", () => {
    const html = renderToStaticMarkup(
      <ChangesList changes={[IRREVERSIBLE]} busyId={null} onOp={() => {}} />,
    );
    expect(html).toContain("Not reversible");
    expect(html).not.toContain(">Undo<");
    expect(html).not.toContain(">Redo<");
  });

  it("drops the Undo button and shows review-only when the id is blocked", () => {
    const html = renderToStaticMarkup(
      <ChangesList
        changes={[REVERSIBLE]}
        busyId={null}
        onOp={() => {}}
        blockedIds={new Set([REVERSIBLE.id])}
      />,
    );
    expect(html).toContain("Not reversible here — review only.");
    expect(html).not.toContain(">Undo<");
    expect(html).not.toContain(">Redo<");
  });
});

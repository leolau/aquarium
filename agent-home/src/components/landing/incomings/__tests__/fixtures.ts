import type { IncomingItem } from "@/types";

const base = {
  owner_user_id: "ada",
  visibility: "private:ada",
  account_id: null,
  conversation: null,
  conversation_name: null,
  sender_id: null,
  ends_at: null,
  registered_at: null,
  importance: null,
  has_attachments: false,
  metadata: {},
  document_id: null,
  remembered_at: null,
  remembered_by: null,
  remembered: false,
  attention_at: "2026-11-11T02:00:00Z",
  attention_cleared_at: null,
  attention_outcome: null,
  todo_count: 0,
};

function item(id: string, over: Partial<IncomingItem>): IncomingItem {
  return { ...base, id, external_id: id, kind: "message", surface: "email", subject: null,
    sender_name: null, body: "", occurred_at: "2026-11-11T01:00:00Z", ...over } as IncomingItem;
}

/** Two urgent (an urgent escalation, a critical event) and two to look at. */
export const flagged: IncomingItem[] = [
  item("in-wa", {
    ref: "M501",
    surface: "whatsapp",
    sender_name: "Grace Hopper",
    body: "Can you confirm the venue tonight?",
    occurred_at: "2026-11-11T04:50:00Z",
    attention_reason: "escalated",
    attention_priority: "urgent",
  }),
  item("in-cal", {
    surface: "calendar",
    kind: "event",
    subject: "Board review",
    occurred_at: "2026-11-11T04:00:00Z",
    attention_reason: "critical_event",
  }),
  item("in-mail", {
    surface: "email",
    sender_name: "Ada Lovelace",
    subject: "Q4 budget sign-off",
    body: "Please approve the attached budget.",
    occurred_at: "2026-11-11T03:00:00Z",
    attention_reason: "escalated",
    attention_priority: "medium",
  }),
  item("in-todo", {
    surface: "email",
    sender_name: "Linus",
    subject: "Patch review",
    occurred_at: "2026-11-11T02:00:00Z",
    attention_reason: "todo",
    todo_count: 2,
  }),
];

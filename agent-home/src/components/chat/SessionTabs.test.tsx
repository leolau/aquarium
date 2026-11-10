import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// SessionTabs is "use client" but its initial render (no hooks that fire in
// SSR besides useState/useMemo/useEffect, and useEffect never fires during
// renderToStaticMarkup) is deterministic from props.
import { SessionTabs } from "@/components/chat/SessionTabs";
import type { SessionSummary } from "@/types";

const NOW_SECONDS = Math.floor(Date.now() / 1000);

const sessions: SessionSummary[] = [
  {
    id: "s1",
    source: "agent_home",
    title: "First chat",
    preview: null,
    message_count: 0,
    started_at: NOW_SECONDS,
    last_active: null,
    ended_at: null,
  },
  {
    id: "s2",
    source: "agent_home",
    title: "Second chat",
    preview: null,
    message_count: 0,
    started_at: NOW_SECONDS,
    last_active: null,
    ended_at: null,
  },
  {
    id: "s3",
    source: "cron",
    title: "Third chat",
    preview: null,
    message_count: 0,
    started_at: NOW_SECONDS,
    last_active: null,
    ended_at: null,
  },
  {
    id: "s4",
    source: "cli",
    cwd: "/opt/data/hermes-home/kanban/workspaces/t_abc",
    title: "Fourth chat",
    preview: null,
    message_count: 0,
    started_at: NOW_SECONDS,
    last_active: null,
    ended_at: null,
  },
];

const baseProps = {
  sessions,
  activeId: "s1",
  busyKeys: [],
  onSelect: () => {},
  onOpenDetails: () => {},
  onNew: () => {},
  onReorder: () => {},
};

describe("SessionTabs", () => {
  it("renders the data-component root", () => {
    const html = renderToStaticMarkup(<SessionTabs {...baseProps} />);
    expect(html).toContain('data-component="SessionTabs"');
  });

  it("shows each chip's short ref", () => {
    const withRef = sessions.map((s, i) => (i === 0 ? { ...s, ref: "C1024" } : s));
    const html = renderToStaticMarkup(
      <SessionTabs {...baseProps} sessions={withRef} activeId="s1" />,
    );
    expect(html).toContain('data-slot="session-ref"');
    expect(html).toContain("C1024");
  });

  it("renders a Category dropdown with one option per non-empty category", () => {
    const html = renderToStaticMarkup(<SessionTabs {...baseProps} />);
    expect(html).toContain('id="chat-category"');
    // s1/s2 -> Daily, s3 (cron) -> Scheduled, s4 (kanban cwd) -> Kanban.
    expect(html).toContain("Kanban (1)");
    expect(html).toContain("Daily (2)");
    expect(html).toContain("Scheduled (1)");
    // No session in this set is old/non-kanban/non-cron.
    expect(html).not.toContain("Others (");
  });

  it("defaults to the active session's own category (s1 is Daily)", () => {
    const html = renderToStaticMarkup(<SessionTabs {...baseProps} activeId="s1" />);
    expect(html).toContain("First chat");
    expect(html).toContain("Second chat");
    // Only the selected category's chips render — s3 (Scheduled) and s4
    // (Kanban) must not appear alongside s1/s2 (Daily).
    expect(html).not.toContain("Third chat");
    expect(html).not.toContain("Fourth chat");
  });

  it("defaults to the kanban session's category when it is active", () => {
    const html = renderToStaticMarkup(<SessionTabs {...baseProps} activeId="s4" />);
    expect(html).toContain("Fourth chat");
    expect(html).not.toContain("First chat");
    expect(html).not.toContain("Second chat");
    expect(html).not.toContain("Third chat");
  });

  it("omits the dropdown entirely when there is nothing to categorize", () => {
    const html = renderToStaticMarkup(
      <SessionTabs {...baseProps} sessions={[]} activeId={null} />,
    );
    expect(html).not.toContain('id="chat-category"');
  });

  it("does NOT render Archived or + New buttons (they moved to the header)", () => {
    const html = renderToStaticMarkup(<SessionTabs {...baseProps} />);
    expect(html).not.toContain("Archived");
    expect(html).not.toContain("+ New");
  });

  it("makes the visible row horizontally scrollable", () => {
    const html = renderToStaticMarkup(<SessionTabs {...baseProps} />);
    expect(html).toContain("overflow-x-auto");
  });
});

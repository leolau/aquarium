// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillUsagePanel, SkillUsageSignal } from "@/components/skills/SkillUsagePanel";
import type { SkillUsageDetail, SkillUsageEvent, SkillUsageRow } from "@/lib/skills/usage";

const NOW = Math.floor(Date.now() / 1000);
const today = new Date().toISOString().slice(0, 10);

const row = (over: Partial<SkillUsageRow> = {}): SkillUsageRow => ({
  name: "pdf-tools",
  uses: 4,
  sessions: 2,
  tasks: 1,
  projects: 1,
  success: 1,
  partial: 0,
  failure: 1,
  unknown: 2,
  success_rate: 0.5,
  last_used_at: NOW - 120,
  trend: [{ day: today, uses: 4 }],
  ...over,
});

const ev = (over: Partial<SkillUsageEvent>): SkillUsageEvent => ({
  id: 1,
  ts: NOW - 60,
  trigger: "skill_view",
  version_id: "v3",
  outcome: null,
  outcome_source: null,
  rating: null,
  note: null,
  session: null,
  task: null,
  project: null,
  user_id: "yan",
  ...over,
});

const EVENTS: SkillUsageEvent[] = [
  ev({ id: 1, session: { id: "s-1", title: "Fill the tax form" } }),
  ev({ id: 2, session: { id: "s-2", title: "Split a report" }, outcome: "success", outcome_source: "user", rating: 1 }),
  ev({
    id: 3,
    trigger: "preload",
    task: { id: "t_9", title: "Merge invoices" },
    project: { slug: "acme", name: "Acme" },
    outcome: "failure",
    outcome_source: "kanban",
    version_id: "v2",
  }),
  ev({ id: 4, session: { id: "s-3", title: null }, version_id: null }),
];

const detail = (over: Partial<SkillUsageDetail> = {}): SkillUsageDetail => ({
  name: "pdf-tools",
  summary: row(),
  by_version: [
    { version_id: "v3", uses: 2, success_rate: 1 },
    { version_id: "v2", uses: 1, success_rate: 0 },
  ],
  events: EVENTS,
  next_cursor: null,
  ...over,
});

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const calls = (prefix: string) => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(prefix));

function routes(detailBody: () => Promise<Response>, feedback?: (body: Record<string, unknown>) => Promise<Response>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/skills/usage/detail")) return detailBody();
    if (url.startsWith("/api/skills/versions")) return reply({ name: "pdf-tools", active: "v3", versions: [] });
    if (url === "/api/skills/usage/feedback" && init?.method === "POST" && feedback) {
      return feedback(JSON.parse(String(init.body)));
    }
    return reply({ detail: "nope" }, 404);
  });
}

const tabHref = (t: string) => `/skills/pdf-tools?tab=${t}`;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillUsagePanel", () => {
  it("shows a loading state until the detail arrives", async () => {
    let resolve!: (r: Response) => void;
    routes(() => new Promise((r) => (resolve = r)));
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading usage");
    await act(async () => resolve(new Response(JSON.stringify(detail()))));
    await waitFor(() => expect(container.querySelector('[data-state="ready"]')).not.toBeNull());
  });

  it("shows an empty state when the skill has not run in the window", async () => {
    routes(() => reply(detail({ summary: row({ uses: 0, sessions: 0, tasks: 0, projects: 0, success: 0, failure: 0, unknown: 0, success_rate: null, last_used_at: null, trend: [] }), by_version: [], events: [] })));
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    await screen.findByText("No runs in the last 90 days");
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("No runs to compare yet.")).toBeTruthy();
    expect(container.querySelector('[data-component="NeedsWork"]')).toBeNull();
  });

  it("shows the error and retries", async () => {
    let fail = true;
    routes(() => (fail ? reply({ detail: "Usage is unavailable." }, 502) : reply(detail())));
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    await screen.findByText("Usage is unavailable.");
    expect(container.querySelector('[data-state="error"]')).not.toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(container.querySelector('[data-state="ready"]')).not.toBeNull());
    expect(calls("/api/skills/usage/detail")).toHaveLength(2);
  });

  it("renders tiles, chart, runs with links, by-version split and the needs-work card", async () => {
    routes(() => reply(detail()));
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="coder" tabHref={tabHref} />);
    await screen.findByText("uses in the last 90 days");
    expect(String(calls("/api/skills/usage/detail")[0][0])).toBe("/api/skills/usage/detail?name=pdf-tools&profile=coder&days=90&limit=50");

    const tiles = [...container.querySelectorAll('[data-component="StatTile"] dd')].map((d) => d.textContent);
    expect(tiles).toEqual(["4", "50%", "2 · 1 · 1", expect.any(String)]);

    const bars = container.querySelectorAll("[data-day]");
    expect(bars).toHaveLength(90);
    await waitFor(() => expect(container.querySelector(`[data-day="${today}"]`)?.hasAttribute("data-active")).toBe(true));

    const runs = container.querySelectorAll('[data-component="UsageRun"]');
    expect(runs).toHaveLength(4);
    const chat = screen.getByRole("link", { name: "Chat · “Fill the tax form”" });
    expect(chat.getAttribute("href")).toBe("/chat?session=s-1");
    const task = screen.getByRole("link", { name: "Task · Merge invoices" });
    expect(task.getAttribute("href")).toBe("/projects/acme/cards/t_9");
    expect(screen.getByText("from kanban run")).toBeTruthy();
    expect(screen.getByText("unversioned")).toBeTruthy();

    // Only unrated chat runs can be rated.
    expect(screen.getAllByRole("button", { name: /^Helpful:/ })).toHaveLength(2);
    const taskRow = container.querySelector('[data-run="3"]') as HTMLElement;
    expect(within(taskRow).queryByRole("button", { name: /Helpful/ })).toBeNull();
    expect(taskRow.querySelector("[data-outcome]")?.textContent).toContain("Failed");

    const side = screen.getByRole("complementary", { name: "Usage by version" });
    expect(within(side).getByText("v3 · active")).toBeTruthy();
    expect(within(side).getByRole("link", { name: "Compare versions" }).getAttribute("href")).toBe("/skills/pdf-tools?tab=versions");
    expect(within(side).getByText(/where|Kanban runs report/)).toBeTruthy();
    expect(within(side).getByText(/1 failed run in the last 90 days/)).toBeTruthy();
    expect(within(side).getByRole("link", { name: /Improve with the agent/ }).getAttribute("href")).toBe("/skills/pdf-tools?tab=improve");
  });

  it("filters the run list", async () => {
    routes(() => reply(detail()));
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    await screen.findByText("uses in the last 90 days");
    const ids = () => [...container.querySelectorAll('[data-component="UsageRun"]')].map((r) => r.getAttribute("data-run"));
    fireEvent.click(screen.getByRole("button", { name: /^Chats/ }));
    expect(ids()).toEqual(["1", "2", "4"]);
    fireEvent.click(screen.getByRole("button", { name: /^Kanban tasks/ }));
    expect(ids()).toEqual(["3"]);
    fireEvent.click(screen.getByRole("button", { name: /^Projects/ }));
    expect(ids()).toEqual(["3"]);
    fireEvent.click(screen.getByRole("button", { name: /^Failed/ }));
    expect(ids()).toEqual(["3"]);
    fireEvent.click(screen.getByRole("button", { name: /^Not rated/ }));
    expect(ids()).toEqual(["1", "4"]);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(ids()).toEqual(["1", "2", "3", "4"]);
  });

  it("switches the window to 30 days", async () => {
    routes(() => reply(detail()));
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    await screen.findByText("uses in the last 90 days");
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    await screen.findByText("uses in the last 30 days");
    expect(String(calls("/api/skills/usage/detail").at(-1)?.[0])).toContain("days=30");
    expect(container.querySelectorAll("[data-day]")).toHaveLength(30);
  });

  it("opens other tabs in place when the page handles them", async () => {
    routes(() => reply(detail()));
    const onOpenTab = vi.fn(() => true);
    render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} onOpenTab={onOpenTab} />);
    fireEvent.click(await screen.findByRole("link", { name: /Improve with the agent/ }));
    fireEvent.click(screen.getByRole("link", { name: "Compare versions" }));
    expect(onOpenTab.mock.calls).toEqual([["improve"], ["versions"]]);
  });

  it("marks a chat run Helpful and updates the counts", async () => {
    const posted: Record<string, unknown>[] = [];
    routes(
      () => reply(detail()),
      (body) => {
        posted.push(body);
        return reply({ ...EVENTS[0], rating: 1, outcome: "success", outcome_source: "user" });
      },
    );
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="coder" tabHref={tabHref} />);
    fireEvent.click(await screen.findByRole("button", { name: "Helpful: Chat · “Fill the tax form”" }));
    await screen.findByText("rated by you");
    expect(posted).toEqual([{ event_id: 1, rating: 1, profile: "coder" }]);
    const first = container.querySelector('[data-run="1"]') as HTMLElement;
    expect(first.querySelector("[data-outcome]")?.textContent).toContain("Success");
    expect(within(first).queryByRole("button", { name: /Helpful/ })).toBeNull();
    const tiles = [...container.querySelectorAll('[data-component="StatTile"] dd')].map((d) => d.textContent);
    expect(tiles[1]).toBe("67%");
  });

  it("marks a chat run Not helpful with a note", async () => {
    const posted: Record<string, unknown>[] = [];
    routes(
      () => reply(detail({ summary: row({ failure: 0, success_rate: 1 }) })),
      (body) => {
        posted.push(body);
        return reply({ ...EVENTS[0], rating: -1, outcome: "failure", outcome_source: "user", note: "Missed page 2" });
      },
    );
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    await screen.findByText("uses in the last 90 days");
    expect(container.querySelector('[data-component="NeedsWork"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not helpful: Chat · “Fill the tax form”" }));
    fireEvent.change(screen.getByLabelText(/What went wrong/), { target: { value: "  Missed page 2 " } });
    fireEvent.click(screen.getByRole("button", { name: "Mark not helpful" }));
    await screen.findByText("“Missed page 2”");
    expect(posted).toEqual([{ event_id: 1, rating: -1, note: "Missed page 2" }]);
    expect(container.querySelector('[data-run="1"] [data-outcome]')?.textContent).toContain("Failed");
    expect(container.querySelector('[data-component="NeedsWork"]')?.textContent).toMatch(/1 failed run and 1 "not helpful" note/);
  });

  it("keeps the run rateable and shows why when feedback fails", async () => {
    routes(
      () => reply(detail()),
      () => reply({ detail: "usage event not found" }, 404),
    );
    render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    fireEvent.click(await screen.findByRole("button", { name: "Helpful: Chat · “Fill the tax form”" }));
    await screen.findByText("usage event not found");
    expect(screen.getByRole("button", { name: "Helpful: Chat · “Fill the tax form”" })).toBeTruthy();
  });

  it("loads older runs from the cursor", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/skills/usage/detail")) {
        return url.includes("cursor=")
          ? reply(detail({ events: [ev({ id: 9, session: { id: "s-9", title: "Old chat" } })], next_cursor: null }))
          : reply(detail({ events: EVENTS.slice(0, 2), next_cursor: "c 1" }));
      }
      return reply({ active: "v3" });
    });
    const { container } = render(<SkillUsagePanel name="pdf-tools" profile="default" tabHref={tabHref} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older runs" }));
    await screen.findByText("Chat · “Old chat”");
    expect(String(calls("/api/skills/usage/detail").at(-1)?.[0])).toContain("cursor=c%201");
    expect(container.querySelectorAll('[data-component="UsageRun"]')).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull();
  });
});

describe("SkillUsageSignal", () => {
  it("shows uses and success rate, or an unused hint", () => {
    const { container, rerender } = render(<SkillUsageSignal row={row({ uses: 12, success_rate: 0.917 })} days={90} />);
    expect(container.textContent).toBe("12 uses · 92% success");
    rerender(<SkillUsageSignal row={row({ uses: 1, success_rate: null })} days={90} />);
    expect(container.textContent).toBe("1 use");
    rerender(<SkillUsageSignal row={undefined} days={90} />);
    expect(container.textContent).toBe("unused in 90 days");
  });
});

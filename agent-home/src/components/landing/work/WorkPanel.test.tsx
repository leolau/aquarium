// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LONG_RUN_MS } from "@/components/ui/useActivityRunning";

import { WorkPanel, WorkPanelView, sortWork } from "./WorkPanel";
import { workStatus } from "./WorkRow";
import { activityItem } from "./fixtures";

const NOW = 1_700_000_000_000;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("workStatus", () => {
  it("maps waiting → Needs you, old runs → Long-running", () => {
    expect(workStatus(activityItem(), NOW)).toBe("running");
    expect(workStatus(activityItem({ status: "waiting" }), NOW)).toBe("waiting");
    expect(workStatus(activityItem({ started_at: (NOW - LONG_RUN_MS) / 1000 }), NOW)).toBe("long");
    expect(workStatus(activityItem({ started_at: null }), NOW)).toBe("running");
  });

  it("sorts waiting first, then long runs, keeping server order", () => {
    const items = [
      activityItem({ id: "a" }),
      activityItem({ id: "b", started_at: (NOW - LONG_RUN_MS - 1) / 1000 }),
      activityItem({ id: "c", status: "waiting" }),
      activityItem({ id: "d" }),
    ];
    expect(sortWork(items, NOW).map((i) => i.id)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("WorkPanelView", () => {
  it("renders a row per item with meta, status pill and link", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    render(
      <WorkPanelView
        loaded
        stale={false}
        items={[
          activityItem({ kind: "chat", id: "s1", name: "Fix login redirect bug", profile: "Engineer", started_at: NOW / 1000 - 180, href: "/chat?session=s1" }),
          activityItem({ id: "r4", name: "Website relaunch", status: "waiting", started_at: NOW / 1000 - 480, href: "/projects/web/runs/4" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[0].getAttribute("data-status")).toBe("waiting");
    expect(rows[0].textContent).toContain("Needs you");
    expect(rows[0].textContent).toContain("Project · waiting 8m");
    expect(rows[1].textContent).toContain("Chat · Engineer · 3m");
    expect(rows[1].textContent).toContain("Running");
    expect(rows[1].querySelector("a")?.getAttribute("href")).toBe("/chat?session=s1");
    expect(screen.getByTestId("work-heading-count").textContent).toBe("2");
    expect(screen.queryByText("View all")).toBeNull();
  });

  it("caps the list and offers View all → /projects", () => {
    const items = Array.from({ length: 8 }, (_, i) => activityItem({ id: `r${i}` }));
    render(<WorkPanelView loaded stale={false} items={items} max={6} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("link", { name: "View all" }).getAttribute("href")).toBe("/projects");
    expect(screen.getByTestId("work-heading-count").textContent).toBe("8");
  });

  it("says so when nothing is running", () => {
    render(<WorkPanelView loaded stale={false} items={[]} />);
    expect(screen.getByTestId("work-empty")).toBeTruthy();
  });
});

describe("WorkPanel", () => {
  it("renders the page's activity read and never fetches on its own", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(
      <WorkPanel
        activity={{ items: [activityItem({ name: "Nightly inbox triage", kind: "cron" })], loaded: true, stale: true }}
      />,
    );
    expect(screen.getByText("Nightly inbox triage")).toBeTruthy();
    expect(container.querySelector("[data-component=WorkPanel]")?.hasAttribute("data-stale")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the skeleton until the page's first read lands", () => {
    render(<WorkPanel activity={{ items: [], loaded: false, stale: false }} />);
    expect(screen.getByTestId("work-skeleton")).toBeTruthy();
  });
});

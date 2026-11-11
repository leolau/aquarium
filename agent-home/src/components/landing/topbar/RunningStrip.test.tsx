// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LONG_RUN_MS } from "@/components/ui/useActivityRunning";
import type { ActivityItem } from "@/types";

import { MOCK_NOW, MOCK_SCHEDULED } from "./mockData";
import { RunningStripView } from "./RunningStrip";
import { SCHEDULED_HREF } from "./ScheduledButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    kind: "chat",
    id: "s1",
    name: "Plan the launch",
    started_at: MOCK_NOW / 1000 - 75,
    href: "/chat?session=s1",
    profile: null,
    status: "running",
    ...over,
  };
}

const chipNames = () =>
  screen.getAllByRole("listitem").map((li) => li.querySelector(".truncate")?.textContent);

describe("RunningStripView", () => {
  it("is hidden when nothing runs and nothing is scheduled", () => {
    const { container } = render(<RunningStripView items={[]} now={MOCK_NOW} scheduled={null} />);
    expect(container.innerHTML).toBe("");
    const zero = { ...MOCK_SCHEDULED, total: 0, projects: 0, cards: 0, cron_jobs: 0 };
    const again = render(<RunningStripView items={[]} now={MOCK_NOW} scheduled={zero} />);
    expect(again.container.innerHTML).toBe("");
  });

  it("orders chips waiting → long-running → running, keeping server order within a tier", () => {
    render(
      <RunningStripView
        now={MOCK_NOW}
        items={[
          item({ id: "a", name: "Running A" }),
          item({ id: "b", name: "Long B", started_at: (MOCK_NOW - LONG_RUN_MS - 1000) / 1000 }),
          item({ id: "c", name: "Waiting C", kind: "project_run", status: "waiting" }),
          item({ id: "d", name: "Running D" }),
        ]}
      />,
    );
    expect(chipNames()).toEqual(["Waiting C", "Long B", "Running A", "Running D"]);
    const statuses = screen
      .getAllByRole("listitem")
      .map((li) => li.querySelector("[data-status]")?.getAttribute("data-status"));
    expect(statuses).toEqual(["waiting", "long", "running", "running"]);
    expect(screen.getByTestId("running-count").textContent).toBe("4");
    expect(screen.getByText("· 1 waiting")).toBeTruthy();
  });

  it("links each chip to its page with a title naming the kind and profile", () => {
    render(
      <RunningStripView
        now={MOCK_NOW}
        items={[
          item({ kind: "card", id: "t1", name: "Draft email", href: "/projects/mkt?card=t1", profile: "writer", status: "waiting" }),
          item({ kind: "cron", id: "default:j1", name: "Backup", href: null }),
        ]}
      />,
    );
    const card = screen.getByText("Draft email").closest("a")!;
    expect(card.getAttribute("href")).toBe("/projects/mkt?card=t1");
    expect(card.getAttribute("title")).toBe("Card: Draft email (writer) — waiting");
    expect(card.textContent).toContain("Needs you · 1m");
    // No page to open → a plain chip, not a dead link.
    const backup = screen.getByText("Backup");
    expect(backup.closest("a")).toBeNull();
    expect(backup.closest("[title]")?.getAttribute("title")).toBe("Scheduled job: Backup");
  });

  it("dims stale reads but keeps the chips", () => {
    const { container } = render(<RunningStripView items={[item()]} now={MOCK_NOW} stale />);
    const root = container.querySelector('[data-component="RunningStrip"]')!;
    expect(root.getAttribute("data-stale")).toBe("true");
    expect(root.className).toContain("opacity-60");
    expect(screen.getByText("Plan the launch")).toBeTruthy();
  });

  it("pins the Scheduled button with its count, href and split tooltip", () => {
    render(<RunningStripView items={[item()]} now={MOCK_NOW} scheduled={MOCK_SCHEDULED} />);
    const button = screen.getByRole("link", { name: /^Scheduled: 6/ });
    expect(button.getAttribute("href")).toBe(SCHEDULED_HREF);
    expect(SCHEDULED_HREF).toBe("/projects?view=project&schedule=set");
    expect(button.textContent).toBe("Scheduled6");
    expect(button.getAttribute("title")).toBe("3 projects · 2 cards · 1 job · next in 2h 00m");
  });

  it("shows 'Nothing running right now' beside the button when only scheduled work exists", () => {
    render(<RunningStripView items={[]} now={MOCK_NOW} scheduled={MOCK_SCHEDULED} />);
    expect(screen.getByTestId("running-empty").textContent).toBe("Nothing running right now");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("link", { name: /^Scheduled: 6/ })).toBeTruthy();
  });

  it("drops the button (not the chips) when the scheduled leg failed", () => {
    render(<RunningStripView items={[item()]} now={MOCK_NOW} scheduled={null} />);
    expect(screen.getByText("Plan the launch")).toBeTruthy();
    expect(document.querySelector('[data-component="ScheduledButton"]')).toBeNull();
  });

  it("scrolls sideways with the arrows when the row overflows", () => {
    render(<RunningStripView items={[item(), item({ id: "s2", name: "Second chat" })]} now={MOCK_NOW} />);
    const list = screen.getByRole("list");
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(list, "scrollWidth", { configurable: true, value: 600 });
    const scrollBy = vi.fn();
    (list as HTMLElement & { scrollBy: typeof scrollBy }).scrollBy = scrollBy;
    fireEvent.scroll(list);
    const right = screen.getByLabelText("Scroll running work right") as HTMLButtonElement;
    const left = screen.getByLabelText("Scroll running work left") as HTMLButtonElement;
    expect(right.disabled).toBe(false);
    expect(left.disabled).toBe(true);
    fireEvent.click(right);
    expect(scrollBy).toHaveBeenCalledWith({ left: 160, behavior: "smooth" });
    expect(list.className).toContain("snap-x");
  });
});

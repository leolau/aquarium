// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createTranslator } from "@/i18n/translate";
import en from "@/i18n/messages/en/landing.json";

import { MOCK_NOW, MOCK_SCHEDULED } from "./mockData";
import { ScheduledButton, scheduledTooltip } from "./ScheduledButton";

afterEach(cleanup);

const t = createTranslator({ landing: en }, "landing");

describe("scheduledTooltip", () => {
  it("splits the count and leaves zero parts out (members never see jobs)", () => {
    expect(scheduledTooltip({ ...MOCK_SCHEDULED, cron_jobs: 0, total: 5 }, MOCK_NOW, t)).toBe(
      "3 projects · 2 cards · next in 2h 00m",
    );
    expect(
      scheduledTooltip({ total: 1, projects: 1, cards: 0, cron_jobs: 0, next_run_at: null }, MOCK_NOW, t),
    ).toBe("1 project");
  });

  it("omits a next run that is already past, and says so when nothing is scheduled", () => {
    expect(
      scheduledTooltip({ ...MOCK_SCHEDULED, next_run_at: MOCK_NOW / 1000 - 60 }, MOCK_NOW, t),
    ).toBe("3 projects · 2 cards · 1 job");
    expect(
      scheduledTooltip({ total: 0, projects: 0, cards: 0, cron_jobs: 0, next_run_at: null }, MOCK_NOW, t),
    ).toBe("Nothing scheduled");
  });
});

describe("ScheduledButton", () => {
  it("compact variant is just ◷ N, still linking to Projects › Scheduled", () => {
    render(<ScheduledButton compact summary={MOCK_SCHEDULED} now={MOCK_NOW} />);
    const link = screen.getByRole("link", { name: /^Scheduled: 6/ });
    expect(link.textContent).toBe("6");
    expect(link.getAttribute("data-variant")).toBe("compact");
    expect(link.className).toContain("h-11");
    expect(link.getAttribute("href")).toBe("/projects?view=project&schedule=set");
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeProjectSkills } from "@/components/projects/skills/model";
import { ProjectSkillsPanel } from "@/components/projects/skills/ProjectSkillsPanel";
import { resetProjectSkillsCache } from "@/components/projects/skills/store";
import type { ProjectSkillsResponse } from "@/types";

const NOW = Math.floor(Date.now() / 1000);

const PAYLOAD: ProjectSkillsResponse = {
  days: 90,
  profiles: [
    { profile: "default", role: "host", can_lab: true },
    { profile: "sales", role: "member", can_lab: false },
    { profile: "finance", role: "member", can_lab: false, hidden: true },
  ],
  skills: [
    { name: "docx-editing", profile: "default", uses: 14, success: 10, partial: 2, failure: 1, unknown: 1, last_used_at: NOW - 600, preloaded: true, trend: [{ day: "2026-11-10", uses: 2 }] },
    { name: "docx-editing", profile: "sales", uses: 3, success: 3, partial: 0, failure: 0, last_used_at: NOW - 7200 },
    { name: "vendor-po", profile: "default", uses: 2, outcomes: { success: 1, partial: 0, failed: 1 }, last_used_at: NOW - 60, created_here: true },
  ],
  preloaded_unused: ["quotation-rewrite"],
  candidates: [{ id: "skc_1", run_no: 4, name: "vendor-po-checklist", preview: "Check the PO against the vendor sheet" }],
};

const DETAIL = {
  name: "docx-editing",
  summary: { name: "docx-editing", uses: 14, sessions: 0, tasks: 9, projects: 1, success: 10, partial: 2, failure: 1, unknown: 1, success_rate: 0.77, last_used_at: NOW - 600, trend: [] },
  by_version: [],
  events: [],
  next_cursor: null,
};

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const renderPanel = (over: Partial<Parameters<typeof ProjectSkillsPanel>[0]> = {}) => {
  const props = {
    slug: "acme",
    hostProfile: "default",
    onOpenSetup: vi.fn(),
    onImprove: vi.fn(),
    onCreate: vi.fn(),
    ...over,
  };
  render(<ProjectSkillsPanel {...props} />);
  return props;
};

beforeEach(() => {
  resetProjectSkillsCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("normalizeProjectSkills", () => {
  it("reads both contract drafts and derives totals when the server leaves them out", () => {
    const view = normalizeProjectSkills(PAYLOAD, 30);
    expect(view.days).toBe(90);
    expect(view.unusedPreloaded).toEqual(["quotation-rewrite"]);
    expect(view.candidates[0]).toMatchObject({ id: "skc_1", runNo: 4 });
    expect(view.skills.find((s) => s.name === "vendor-po")?.failed).toBe(1);
    // Same name in two profiles stays two rows.
    expect(view.skills.filter((s) => s.name === "docx-editing")).toHaveLength(2);
    expect(view.totals.uses).toBe(19);
    expect(view.totals.worthImproving).toBe(2);
    expect(view.totals.firstTimeRate).toBeCloseTo(14 / 18);
    const partB = normalizeProjectSkills(
      { window_days: 30, totals: { skills: 1, uses: 5, first_time_success_rate: 0.6, worth_improving: 0 }, skills: [], unused_preloaded: ["a"], candidates: [{ id: "x", name: "y", run: 2, preview: null }] },
      90,
    );
    expect(partB).toMatchObject({ days: 30, totals: { uses: 5, firstTimeRate: 0.6 }, unusedPreloaded: ["a"] });
    expect(partB.candidates[0].runNo).toBe(2);
  });
});

describe("ProjectSkillsPanel", () => {
  it("shows loading, then rows per profile, stats, unused preloaded, candidates and the hidden profile", async () => {
    fetchMock.mockImplementation(() => json(PAYLOAD));
    renderPanel();
    expect(screen.getByRole("status").textContent).toContain("Loading skills");
    await screen.findByText("vendor-po-checklist");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/acme/skills?days=90");
    const rows = document.querySelectorAll('[data-component="ProjectSkillRow"]');
    expect(rows).toHaveLength(3);
    // Several profiles: rows carry a profile chip.
    expect(screen.getByLabelText("Profile sales")).toBeTruthy();
    expect(screen.getByText("Times used").previousElementSibling?.textContent).toBe("19");
    expect(screen.getByTestId("skills-unused").textContent).toContain("quotation-rewrite");
    expect(screen.getByTestId("skills-hidden-profiles").textContent).toContain("finance");
    expect(screen.getByText("Created here", { selector: "span" })).toBeTruthy();
  });

  it("refetches behind the cached list when it mounts again, so new runs show without a full reload", async () => {
    fetchMock.mockImplementation(() => json(PAYLOAD));
    renderPanel();
    await screen.findByText("vendor-po-checklist");
    cleanup();

    const fresh = { ...PAYLOAD.skills[0], name: "fresh-skill" };
    fetchMock.mockImplementation(() => json({ ...PAYLOAD, skills: [...PAYLOAD.skills, fresh] }));
    renderPanel();
    expect(screen.getByText("vendor-po-checklist")).toBeTruthy();
    await screen.findByText("fresh-skill");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hides Uses / Improve where the caller lacks lab, and New skill when the host profile lacks it", async () => {
    fetchMock.mockImplementation(() => json(PAYLOAD));
    const props = renderPanel();
    await screen.findByText("vendor-po-checklist");
    const sales = document.querySelector('[data-skill="sales/docx-editing"]') as HTMLElement;
    expect(within(sales).queryByText("Improve with AI")).toBeNull();
    expect(within(sales).queryByText("Uses")).toBeNull();
    const own = document.querySelector('[data-skill="default/docx-editing"]') as HTMLElement;
    fireEvent.click(within(own).getByText("Improve with AI"));
    expect(props.onImprove).toHaveBeenCalledWith(expect.objectContaining({ name: "docx-editing", profile: "default" }));
    fireEvent.click(screen.getByText("New skill with AI"));
    expect(props.onCreate).toHaveBeenCalledWith({});
    fireEvent.click(screen.getByText("Create with AI"));
    expect(props.onCreate).toHaveBeenCalledWith({ candidateId: "skc_1" });
    cleanup();

    resetProjectSkillsCache();
    fetchMock.mockImplementation(() =>
      json({ ...PAYLOAD, profiles: PAYLOAD.profiles!.map((p) => ({ ...p, can_lab: false })) }),
    );
    renderPanel();
    await screen.findByText("vendor-po-checklist");
    expect(screen.queryByText("Improve with AI")).toBeNull();
    expect(screen.queryByText("New skill with AI")).toBeNull();
    expect(screen.queryByText("Create with AI")).toBeNull();
    expect(screen.queryByText("Uses", { selector: "button" })).toBeNull();
  });

  it("opens the project-filtered usage sheet from Uses", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).startsWith("/api/projects/") ? json(PAYLOAD) : json(DETAIL),
    );
    renderPanel();
    await screen.findByText("vendor-po-checklist");
    const own = document.querySelector('[data-skill="default/docx-editing"]') as HTMLElement;
    fireEvent.click(within(own).getByText("Uses"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/skills/usage/detail?name=docx-editing&project=acme"))).toBe(true),
    );
  });

  it("dismisses a candidate and drops it (and the badge source) from the list", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ ok: true }) : json(PAYLOAD),
    );
    renderPanel();
    await screen.findByText("vendor-po-checklist");
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() => expect(screen.queryByText("vendor-po-checklist")).toBeNull());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/projects/acme/skills/candidates/skc_1/dismiss");
  });

  it("hides Dismiss on an archived project", async () => {
    fetchMock.mockImplementation(() => json(PAYLOAD));
    renderPanel({ archived: true });
    await screen.findByText("vendor-po-checklist");
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("shows the empty state and the Setup link", async () => {
    fetchMock.mockImplementation(() => json({ days: 90, profiles: [], skills: [], candidates: [] }));
    const props = renderPanel();
    expect((await screen.findByTestId("skills-empty")).textContent).toContain("last 90 days");
    fireEvent.click(screen.getByText("Manage preloaded skills in Setup"));
    expect(props.onOpenSetup).toHaveBeenCalled();
  });

  it("shows the error state and retries", async () => {
    fetchMock.mockImplementationOnce(() => json({ error: "boom" }, 500)).mockImplementation(() => json(PAYLOAD));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load");
    fireEvent.click(screen.getByText("Try again"));
    await screen.findByText("vendor-po-checklist");
  });

  it("refetches when the window changes", async () => {
    fetchMock.mockImplementation(() => json(PAYLOAD));
    renderPanel();
    await screen.findByText("vendor-po-checklist");
    fireEvent.change(screen.getByLabelText("Time window"), { target: { value: "30" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/projects/acme/skills?days=30")).toBe(true));
  });
});

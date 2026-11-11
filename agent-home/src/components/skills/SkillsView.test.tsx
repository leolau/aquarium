// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { SkillsView } from "@/components/skills/SkillsView";
import type { SkillInfo } from "@/types";

const SKILLS: SkillInfo[] = [
  { name: "pdf-tools", description: "Fill PDFs.", category: "productivity", enabled: true, source: "builtin" },
  { name: "linear", description: "Linear issues.", category: "work", enabled: true, source: "hub" },
];

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = () => <SkillsView profiles={["default", "coder"]} profile="coder" initialSkills={SKILLS} initialView="installed" error={null} />;

describe("SkillsView usefulness signal", () => {
  it("fetches usage once and shows uses, success rate and an unused hint", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/skills/usage")
        ? reply({ days: 90, skills: [{ name: "pdf-tools", uses: 12, sessions: 9, tasks: 3, projects: 1, success: 9, partial: 0, failure: 1, unknown: 2, success_rate: 0.9, last_used_at: 1790000000, trend: [] }] })
        : reply([]),
    );
    const { rerender } = render(view());
    await screen.findByText("12 uses · 90% success");
    expect(screen.getByText("unused in 90 days")).toBeTruthy();
    rerender(view());
    const usageCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/skills/usage"));
    expect(usageCalls.map(([u]) => u)).toEqual(["/api/skills/usage?days=90&profile=coder"]);
  });

  it("leaves the list as is when usage is unavailable", async () => {
    fetchMock.mockImplementation(() => reply({ detail: "down" }, 502));
    const { container } = render(view());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText("pdf-tools")).toBeTruthy();
    expect(container.querySelector('[data-component="SkillUsageSignal"]')).toBeNull();
  });
});

describe("SkillsView Skills permissions", () => {
  const READ_ONLY = { use: true, view: true, agent_edit: false, manage: false, lab: false };

  it("without manage or lab: read-only list, no hub, no usage fetch", async () => {
    fetchMock.mockImplementation(() => reply([]));
    const { container } = render(
      <SkillsView profiles={["default"]} profile="default" initialSkills={SKILLS} initialView="hub" error={null} permissions={READ_ONLY} />,
    );
    expect(screen.getByText("pdf-tools")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Hub" })).toBeNull();
    expect(container.querySelector('[data-action="new-skill"]')).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(container.querySelectorAll('[data-state="on"]')).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/skills/usage"))).toEqual([]);
  });

  it("with manage: edit controls and the hub", () => {
    fetchMock.mockImplementation(() => reply([]));
    const { container } = render(
      <SkillsView profiles={["default"]} profile="default" initialSkills={SKILLS} initialView="installed" error={null} permissions={{ ...READ_ONLY, manage: true }} />,
    );
    expect(screen.getByRole("tab", { name: "Hub" })).toBeTruthy();
    expect(container.querySelector('[data-action="new-skill"]')).not.toBeNull();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });
});

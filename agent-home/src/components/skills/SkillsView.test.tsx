// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { SkillsView } from "@/components/skills/SkillsView";
import type { SkillLibrary, TriageStatus } from "@/types";

const LIBRARY: SkillLibrary = {
  profiles: ["default", "coder"],
  skills: [
    { name: "pdf-tools", description: "Fill PDFs.", category: "productivity", source: "builtin", owners: [], used_by: [{ profile: "default", enabled: true }, { profile: "coder", enabled: false }] },
    { name: "linear", description: "Linear issues.", category: "work", source: "hub", trust_level: "trusted", owners: [], used_by: [{ profile: "coder", enabled: true }] },
    { name: "leave-policy", description: "HR leave.", category: "hr", source: "profile", owners: ["coder"], used_by: [{ profile: "coder", enabled: true }] },
  ],
};
const TRIAGE = {
  profile: "default",
  kinds: [{ kind: "email", label: "Email triage", status: "set_up", skills: [{ name: "email-triage", layer: "base", path: "", present: true, files: [] }] }],
} as unknown as TriageStatus;

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

const view = (extra: Partial<Parameters<typeof SkillsView>[0]> = {}) => (
  <SkillsView profiles={["default", "coder"]} profile="default" initialLibrary={LIBRARY} triage={TRIAGE} initialView="installed" error={null} {...extra} />
);
const rowNames = (c: HTMLElement) => [...c.querySelectorAll('[data-component="SkillRow"]')].map((e) => e.getAttribute("data-skill"));

describe("SkillsView library", () => {
  it("lists every skill once with a Used by column (on / removed per profile)", () => {
    const { container } = render(view());
    expect(rowNames(container)).toEqual(["pdf-tools", "linear", "leave-policy", "email-triage"]);
    const pdf = container.querySelector('[data-skill="pdf-tools"]')!;
    expect(pdf.querySelector('[data-used-by="default"]')!.getAttribute("data-state")).toBe("on");
    expect(pdf.querySelector('[data-used-by="coder"]')!.getAttribute("data-state")).toBe("off");
    expect(screen.getByText("email triage · on for you")).toBeTruthy();
  });

  it("filters by source chip, ◆ Triage and Used by profile", () => {
    const { container } = render(view());
    fireEvent.click(container.querySelector('[data-filter="profile"]')!);
    expect(rowNames(container)).toEqual(["leave-policy"]);
    fireEvent.click(container.querySelector('[data-filter="triage"]')!);
    expect(rowNames(container)).toEqual(["email-triage"]);
    fireEvent.click(container.querySelector('[data-filter="all"]')!);
    fireEvent.change(screen.getByLabelText("Used by"), { target: { value: "default" } });
    expect(rowNames(container)).toEqual(["pdf-tools"]);
  });
});

describe("SkillsView usefulness signal", () => {
  it("fetches usage once when lab is allowed", async () => {
    fetchMock.mockImplementation(() => reply({ days: 90, skills: [] }));
    render(view());
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/skills/usage"))).toHaveLength(1));
  });
});

describe("SkillsView Skills permissions", () => {
  const READ_ONLY = { use: true, view: true, agent_edit: false, manage: false, lab: false };

  it("without manage or lab: read-only library, no hub, no usage fetch", async () => {
    fetchMock.mockImplementation(() => reply([]));
    const { container } = render(view({ initialView: "hub", permissions: READ_ONLY }));
    expect(screen.getByText("pdf-tools")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Hub" })).toBeNull();
    expect(container.querySelector('[data-action="new-skill"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.getByTestId("skills-library-hint").textContent).toMatch(/Only an owner or admin/);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/skills/usage"))).toEqual([]);
  });

  it("with manage: edit links and the hub", () => {
    fetchMock.mockImplementation(() => reply([]));
    const { container } = render(view({ permissions: { ...READ_ONLY, manage: true }, canAdminister: true }));
    expect(screen.getByRole("tab", { name: "Hub" })).toBeTruthy();
    expect(container.querySelector('[data-action="new-skill"]')).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /^Edit / })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Edit leave-policy" }).getAttribute("href")).toBe("/skills/leave-policy/edit?profile=coder");
  });
});

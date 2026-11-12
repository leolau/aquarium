// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { ProfileSkillsPanel } from "@/components/profiles/ProfileSkillsPanel";
import type { SkillLibrary } from "@/types";

const LIBRARY: SkillLibrary = {
  profiles: ["default", "hr", "engineers"],
  skills: [
    { name: "google-workspace", description: "Gmail", category: "productivity", source: "builtin", owners: [], used_by: [{ profile: "hr", enabled: true }] },
    { name: "docx-editing", description: "Word", category: "productivity", source: "shared", owners: [], used_by: [{ profile: "hr", enabled: false }] },
    { name: "linear", description: "Issues", category: "dev", source: "hub", owners: [], used_by: [{ profile: "engineers", enabled: true }] },
    { name: "leave-policy-hk", description: "Leave", category: "hr", source: "profile", owners: ["hr"], used_by: [{ profile: "hr", enabled: true }] },
    { name: "deploy-notes", description: "Deploys", category: "dev", source: "profile", owners: ["engineers"], used_by: [{ profile: "engineers", enabled: true }] },
  ],
};

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([u, init]) => [String(u), JSON.parse(String((init as RequestInit).body))]);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === "POST" ? reply({ ok: true }) : reply(LIBRARY),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rows = (c: HTMLElement, state: string) =>
  [...c.querySelectorAll(`[data-component="ProfileSkillRow"][data-state="${state}"]`)].map((e) => e.getAttribute("data-skill"));

describe("ProfileSkillsPanel", () => {
  it("lists the profile's skills on and removed, with a triage slot on top", async () => {
    const { container } = render(<ProfileSkillsPanel profile="hr" />);
    await waitFor(() => expect(screen.getByTestId("profile-skills-summary").textContent).toMatch(/2 on for hr · 1 removed/));
    expect(rows(container, "on")).toEqual(["google-workspace", "leave-policy-hk"]);
    expect(rows(container, "off")).toEqual(["docx-editing"]);
    expect(container.querySelector('[data-slot="profile-skills-triage"]')).not.toBeNull();
  });

  it("Remove turns a skill off for this profile only", async () => {
    const { container } = render(<ProfileSkillsPanel profile="hr" />);
    await screen.findByText("google-workspace");
    fireEvent.click(container.querySelector('[data-skill="google-workspace"] [data-action="remove-skill"]')!);
    await waitFor(() => expect(posts()).toEqual([["/api/skills/library/remove", { target: "hr", name: "google-workspace" }]]));
  });

  it("offers Delete only on the profile's own skills, behind a confirm", async () => {
    render(<ProfileSkillsPanel profile="hr" />);
    await screen.findByText("google-workspace");
    expect(screen.queryByRole("button", { name: "Delete google-workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete docx-editing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete leave-policy-hk" }));
    expect(posts()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete skill" }));
    await waitFor(() => expect(posts()).toEqual([["/api/skills/library/delete", { target: "hr", name: "leave-policy-hk" }]]));
  });

  it("asks shared vs only-here each time a skill comes from another profile", async () => {
    render(<ProfileSkillsPanel profile="hr" />);
    await screen.findByText("google-workspace");
    fireEvent.click(screen.getByRole("button", { name: "+ Add from library" }));
    const options = [...document.querySelectorAll('[data-component="AddSkillOption"]')].map((e) => e.getAttribute("data-skill"));
    expect(options).toEqual(["docx-editing", "linear", "deploy-notes"]);
    fireEvent.click(screen.getByRole("button", { name: "Add deploy-notes" }));
    const confirm = screen.getByRole("button", { name: "Add skill" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Copy only into hr/));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(posts()).toEqual([["/api/skills/library/add", { target: "hr", name: "deploy-notes", where: "only" }]]),
    );
  });

  it("adds a hub or built-in skill straight away", async () => {
    render(<ProfileSkillsPanel profile="hr" />);
    await screen.findByText("google-workspace");
    fireEvent.click(screen.getByRole("button", { name: "+ Add from library" }));
    fireEvent.click(screen.getByRole("button", { name: "Add linear" }));
    await waitFor(() => expect(posts()).toEqual([["/api/skills/library/add", { target: "hr", name: "linear" }]]));
  });
});

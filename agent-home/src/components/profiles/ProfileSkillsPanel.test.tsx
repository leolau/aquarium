// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { ProfileSkillsPanel } from "@/components/profiles/ProfileSkillsPanel";
import { kind, status } from "@/components/profiles/triage-fixtures";
import type { SkillLibrary, TriageStatus } from "@/types";

const LIBRARY: SkillLibrary = {
  profiles: ["default", "hr", "engineers"],
  skills: [
    { name: "google-workspace", description: "Gmail", category: "productivity", source: "builtin", owners: [], used_by: [{ profile: "hr", enabled: true }] },
    { name: "docx-editing", description: "Word", category: "productivity", source: "shared", owners: [], used_by: [{ profile: "hr", enabled: false }] },
    { name: "linear", description: "Issues", category: "dev", source: "hub", owners: [], used_by: [{ profile: "engineers", enabled: true }] },
    { name: "leave-policy-hk", description: "Leave", category: "hr", source: "profile", owners: ["hr"], used_by: [{ profile: "hr", enabled: true }] },
    { name: "deploy-notes", description: "Deploys", category: "dev", source: "profile", owners: ["engineers"], used_by: [{ profile: "engineers", enabled: true }] },
    { name: "email-triage", description: "Email triage", category: "triage", source: "shared", owners: [], used_by: [] },
  ],
};
const TRIAGE_OFF = status(["email", "whatsapp", "calendar"].map((k) => kind(k as "email", "not_set_up", ["account"])));

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([u, init]) => [String(u), JSON.parse(String((init as RequestInit).body))]);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === "POST" ? reply({ ok: true }) : String(_url).startsWith("/api/triage/status") ? reply(TRIAGE_OFF) : reply(LIBRARY),
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

  it("keeps triage skills out of the Add picker", async () => {
    const custom = status([{ ...kind("email", "set_up"), skills: [{ ...kind("email", "set_up").skills[0], name: "my-triage-rules" }] }]);
    const withOverlay: SkillLibrary = {
      ...LIBRARY,
      skills: [...LIBRARY.skills, { name: "my-triage-rules", description: "Overlay", category: "triage", source: "shared", owners: [], used_by: [] }],
    };
    fetchMock.mockImplementation((url: string) => reply(String(url).startsWith("/api/triage/status") ? custom : withOverlay));
    render(<ProfileSkillsPanel profile="hr" />);
    await screen.findByText("google-workspace");
    await screen.findByText(/Triage · set up for you/);
    fireEvent.click(screen.getByRole("button", { name: "+ Add from library" }));
    const options = [...document.querySelectorAll('[data-component="AddSkillOption"]')].map((e) => e.getAttribute("data-skill"));
    expect(options).not.toContain("email-triage");
    expect(options).not.toContain("my-triage-rules");
  });

  it("shows the Triage card for this profile only, and drops another profile's late reply", async () => {
    let releaseHr: (v: Response) => void = () => {};
    const HR: TriageStatus = status([{ ...kind("email", "set_up"), accounts: [{ address: "leo@hr.example", enabled: true, credential: true, in_triage: true }] }]);
    const ENG: TriageStatus = { ...TRIAGE_OFF, profile: "engineers" };
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/triage/status?profile=hr") return new Promise<Response>((r) => (releaseHr = r));
      if (u === "/api/triage/status?profile=engineers") return reply(ENG);
      return reply(LIBRARY);
    });
    const { container, rerender } = render(<ProfileSkillsPanel profile="hr" />);
    await waitFor(() => expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/api/triage/status?profile=hr"));
    rerender(<ProfileSkillsPanel profile="engineers" />);
    await screen.findByText(/Triage · not set up yet/);
    releaseHr(new Response(JSON.stringify(HR), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    const triageCard = container.querySelector('[data-component="TriageCard"]') as HTMLElement;
    expect(triageCard.dataset.state).toBe("not_set_up");
    expect(container.textContent).not.toContain("escalation-rules.md");
    expect(fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/triage/"))).toEqual([
      "/api/triage/status?profile=hr",
      "/api/triage/status?profile=engineers",
    ]);
  });
});

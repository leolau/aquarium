// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkillsPermissionsSection } from "@/components/settings/SkillsPermissionsSection";
import type { SkillPermissions, SkillRolePermissions, SkillsAccessResponse } from "@/lib/skills/permissions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ACTIONS: SkillsAccessResponse["actions"] = [
  { key: "use", label: "Agent uses skills in their chats", description: "Loads skills while it works." },
  { key: "view", label: "See the skill list and read skills", description: "Opens the Skills app." },
  { key: "agent_edit", label: "Ask the agent to create or edit skills (incl. /learn)", description: "skill_manage." },
  { key: "manage", label: "Create, edit, turn on/off or install skills in settings", description: "Skills app controls." },
  { key: "lab", label: "Skills Lab: Usage, Versions, Improve", description: "The Skills Lab tabs." },
];
const ALL: SkillPermissions = { use: true, view: true, agent_edit: true, manage: true, lab: true };
const USE: SkillPermissions = { use: true, view: false, agent_edit: false, manage: false, lab: false };

function role(name: SkillRolePermissions["role"], actions: SkillPermissions, extra: Partial<SkillRolePermissions> = {}): SkillRolePermissions {
  const labels = { owner: "The owner", admin: "Admins", member: "Members", viewer: "Viewers" } as const;
  return { role: name, label: labels[name], locked: name === "owner", editable: name !== "owner", customised: false, actions, ...extra };
}

function state(overrides: Partial<Record<SkillRolePermissions["role"], Partial<SkillRolePermissions>>> = {}): SkillsAccessResponse {
  return {
    actions: ACTIONS,
    roles: [
      role("owner", ALL, overrides.owner),
      role("admin", ALL, overrides.admin),
      role("member", USE, overrides.member),
      role("viewer", USE, overrides.viewer),
    ],
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const sw = (name: string) => screen.getByRole("switch", { name }) as HTMLButtonElement;

describe("SkillsPermissionsSection", () => {
  it("shows the 5 actions for the 4 roles, with the owner column locked on", async () => {
    mockFetch(() => state());
    render(<SkillsPermissionsSection />);
    await screen.findByText("Skills Lab: Usage, Versions, Improve");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(screen.getAllByRole("switch")).toHaveLength(20);
    expect([...document.querySelectorAll("thead th[data-role]")].map((n) => n.getAttribute("data-role"))).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
    ]);
    for (const a of ACTIONS) {
      const owner = sw(`The owner: ${a.label}`);
      expect(owner.getAttribute("aria-checked")).toBe("true");
      expect(owner.disabled).toBe(true);
    }
    expect(screen.getByText("Always on")).toBeTruthy();
    expect(sw("Members: See the skill list and read skills").getAttribute("aria-checked")).toBe("false");
    expect(sw("Members: See the skill list and read skills").disabled).toBe(false);
    expect(screen.getAllByText("new chats")).toHaveLength(2);
    expect(document.querySelector('[data-note="tool-rows"]')?.textContent).toMatch(/apply to new chats/);
    expect(screen.queryByText("Only the owner can change what admins can do.")).toBeNull();
  });

  it("disables the admin column for an admin caller, with the hint", async () => {
    mockFetch(() => state({ admin: { editable: false, customised: true } }));
    render(<SkillsPermissionsSection />);
    await screen.findByText("Only the owner can change what admins can do.");
    expect(sw("Admins: Skills Lab: Usage, Versions, Improve").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Reset admins to default" })).toBeNull();
    expect(sw("Members: Skills Lab: Usage, Versions, Improve").disabled).toBe(false);
  });

  it("toggles one action and shows what the server turned on with it", async () => {
    const after = state({ member: { customised: true, actions: { ...USE, view: true, manage: true } } });
    const fetchSpy = mockFetch((_url, init) => (init?.method === "PUT" ? after : state()));
    render(<SkillsPermissionsSection />);
    await screen.findByText("Skills Lab: Usage, Versions, Improve");
    fireEvent.click(sw("Members: Create, edit, turn on/off or install skills in settings"));
    await waitFor(() =>
      expect(sw("Members: See the skill list and read skills").getAttribute("aria-checked")).toBe("true"),
    );
    const put = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe("/api/access/skills/member");
    expect(JSON.parse(String(put[1]!.body))).toEqual({ actions: { manage: true } });
    expect(screen.getByText("Members: Also turned on: See the skill list and read skills.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset members to default" })).toBeTruthy();
  });

  it("ignores a second tap while saving", async () => {
    let release: (v: unknown) => void = () => {};
    const fetchSpy = mockFetch((_url, init) =>
      init?.method === "PUT" ? new Promise((r) => (release = () => r(state()))) : state(),
    );
    render(<SkillsPermissionsSection />);
    await screen.findByText("Skills Lab: Usage, Versions, Improve");
    fireEvent.click(sw("Viewers: Skills Lab: Usage, Versions, Improve"));
    fireEvent.click(sw("Members: Skills Lab: Usage, Versions, Improve"));
    expect(await screen.findByText("Saving…")).toBeTruthy();
    release(null);
    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("resets a customised role", async () => {
    const fetchSpy = mockFetch((_url, init) =>
      init?.method === "PUT" ? state() : state({ viewer: { customised: true, actions: { ...USE, view: true } } }),
    );
    render(<SkillsPermissionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Reset viewers to default" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset viewers to default" })).toBeNull());
    const put = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe("/api/access/skills/viewer");
    expect(JSON.parse(String(put[1]!.body))).toEqual({ reset: true });
  });

  it("shows the server's refusal next to the grid", async () => {
    mockFetch((_url, init) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({ detail: "Only the owner can change what admins can do." }), { status: 403 })
        : state(),
    );
    render(<SkillsPermissionsSection />);
    await screen.findByText("Skills Lab: Usage, Versions, Improve");
    fireEvent.click(sw("Admins: Skills Lab: Usage, Versions, Improve"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't save admins: Only the owner can change what admins can do.",
    );
    expect(sw("Admins: Skills Lab: Usage, Versions, Improve").getAttribute("aria-checked")).toBe("true");
  });

  it("says so when the permissions can't be loaded", async () => {
    mockFetch(() => new Response(JSON.stringify({ detail: "Only the owner or an admin can change this setting." }), { status: 403 }));
    render(<SkillsPermissionsSection />);
    expect(await screen.findByText(/Couldn't load skills permissions/)).toBeTruthy();
  });
});

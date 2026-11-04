// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProfileCreate } from "@/components/profiles/NewProfileDialog";
import { ProfilesView } from "@/components/profiles/ProfilesView";
import type { ProfileInfo } from "@/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const P = (over: Partial<ProfileInfo>): ProfileInfo => ({
  name: "default",
  is_default: false,
  description: "",
  description_auto: false,
  model: "claude-sonnet",
  provider: "anthropic",
  has_env: true,
  skill_count: 4,
  gateway_running: false,
  ...over,
});

const PROFILES = [
  P({ name: "default", is_default: true, description: "Main assistant", gateway_running: true }),
  P({ name: "coder", description: "Writes code", description_auto: true, skill_count: 1 }),
];

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("buildProfileCreate", () => {
  const base = {
    name: " smoke-x ",
    description: "",
    source: "default",
    provider: "",
    model: "",
    available: ["a", "b"],
    hubSkills: [],
  };
  it("sends keep_skills only when something was unticked", () => {
    expect(buildProfileCreate({ ...base, startFrom: "blank", kept: new Set(["a", "b"]) })).toMatchObject({
      name: "smoke-x",
      clone_from: null,
      clone_all: false,
      keep_skills: [],
    });
    expect(buildProfileCreate({ ...base, startFrom: "copy", kept: new Set(["b"]) })).toMatchObject({
      clone_from: "default",
      clone_all: false,
      keep_skills: ["b"],
    });
    expect(buildProfileCreate({ ...base, startFrom: "all", kept: new Set(["a", "b"]) })).toMatchObject({
      clone_from: "default",
      clone_all: true,
    });
  });
});

describe("ProfilesView", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/soul")) return reply({ content: "You are kind." });
      if (url.startsWith("/api/skills")) return reply([{ name: "a", description: "", category: "c", enabled: true }]);
      return reply({ profiles: PROFILES });
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a card per profile with default badge, auto chip, model, skills and gateway", () => {
    render(<ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />);
    expect(document.querySelectorAll('[data-component="ProfileCard"]')).toHaveLength(2);
    expect(screen.getByText("default", { selector: "[data-component=Pill]" })).toBeTruthy();
    expect(screen.getByText("auto description")).toBeTruthy();
    expect(screen.getByText("gateway running")).toBeTruthy();
    expect(screen.getByText("1 skill")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Profile suggestions" }).getAttribute("href")).toBe("/profiles/suggestions");
  });

  it("the default profile cannot be renamed or deleted", async () => {
    render(<ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />);
    fireEvent.click(document.querySelector('[data-profile="default"]')!);
    await screen.findByDisplayValue("You are kind.");
    expect(screen.queryByRole("button", { name: "Rename…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    expect(screen.getByText(/Path: hidden for safety/)).toBeTruthy();
  });

  it("delete needs the profile name typed before it is sent", async () => {
    render(<ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />);
    fireEvent.click(document.querySelector('[data-profile="coder"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete…" }));
    const confirm = screen.getByRole("button", { name: "Delete profile" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type the profile name/i), { target: { value: "code" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type the profile name/i), { target: { value: "coder" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/profiles/named/coder", expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("new profile dialog walks the steps and creates with one POST", async () => {
    render(<ProfilesView initialProfiles={PROFILES} providers={[]} error={null} />);
    fireEvent.click(screen.getByTestId("new-profile"));
    const next = screen.getByRole("button", { name: "Next →" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("research-helper"), { target: { value: "smoke-new" } });
    fireEvent.click(next);
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    expect(screen.getByTestId("new-profile-review").textContent).toContain("smoke-new");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/profiles", expect.objectContaining({ method: "POST" })),
    );
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toMatchObject({ name: "smoke-new", clone_from: null });
  });
});

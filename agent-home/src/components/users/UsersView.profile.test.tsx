// @vitest-environment jsdom
/**
 * FG-28 C3: the Users screen administers the profile picked in `?profile=`,
 * and every members request it makes — reads and mutations alike — names that
 * profile, so the BFF (and Python) judge the caller's role there.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { PAGE_SIZE } from "@/components/users/api";
import { UsersView } from "@/components/users/UsersView";
import type { Member, MembersResponse, ProfileSummary } from "@/types";

const p = (name: string): ProfileSummary => ({ name, is_default: name === "default", description: "" });

const MIA: Member = {
  user_id: "a1b2c3",
  display: "Mia",
  role: "member",
  email: "mia@x.io",
  active: true,
  enrolled: true,
  channels: [],
  is_owner: false,
  invitation: {
    id: "inv-1",
    user_id: "a1b2c3",
    kind: "activation",
    status: "open",
    expires_at: "2026-08-12T10:35:00+00:00",
    used_at: null,
    revoked_at: null,
    created_by: "leo",
    created_at: "2026-08-12T10:30:00+00:00",
  },
};
const LEO: Member = { ...MIA, user_id: "leo", display: "Leo", role: "admin", invitation: null };

const PAGE: MembersResponse = {
  configured: true,
  members: [MIA, LEO],
  total: 2,
  limit: PAGE_SIZE,
  offset: 0,
  profile: "hr",
};

let fetchMock: ReturnType<typeof vi.fn>;
const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: new URL(String(url), "http://x"),
    method: (init as RequestInit | undefined)?.method ?? "GET",
    body: (init as RequestInit | undefined)?.body
      ? JSON.parse(String((init as RequestInit).body))
      : undefined,
  }));

function view(profiles: ProfileSummary[], role: "owner" | "admin" = "owner") {
  return render(
    <UsersView
      role={role}
      userId="leo"
      profile="hr"
      administered={profiles}
      directory={{ configured: true, entries: [], total: 0, profile: "hr" }}
      initialPage={PAGE}
    />,
  );
}

describe("UsersView — the administered profile (FG-28 C3)", () => {
  beforeEach(() => {
    fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url), "http://x").pathname;
      if (path.endsWith("/invitation")) {
        return Response.json({ activation_path: "/activate?t=x", invitation: MIA.invitation });
      }
      if (path === "/api/comms/members/activity") return Response.json({ events: [] });
      if (path === "/api/comms/members/import") {
        return Response.json({ dry_run: true, rows: [], created: 0, enrolled: 0, errors: [] });
      }
      if (path === "/api/comms/members" ) {
        return Response.json({ ...PAGE, member: MIA, activation_path: null });
      }
      return Response.json({ ...PAGE, entries: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    router.push.mockReset();
  });

  it("hides the switcher for someone administering one profile, still naming it", () => {
    const { container } = view([p("hr")]);
    expect(container.querySelector('[data-component="AdminProfileSwitcher"]')).toBeNull();
    expect(container.textContent).toContain("profile: hr");
  });

  it("names the selected profile on every members fetch and mutation", async () => {
    view([p("default"), p("hr")]);

    // One action at a time: a mutation holds every row busy until it re-reads.
    const step = async (act: () => void, calls = 2) => {
      const before = fetchMock.mock.calls.length;
      act();
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before + calls));
      await waitFor(() => expect(screen.getByRole("button", { name: "Suspend" })).not.toHaveProperty("disabled", true));
    };
    const click = (name: string) => () => fireEvent.click(screen.getAllByRole("button", { name })[0]);
    const type = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });

    await step(() => type("Role for Mia", "admin"));
    await step(click("Suspend"));
    await step(click("Regenerate link"));
    await step(click("Revoke link"));
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    type("Display name for a1b2c3", "Mia K");
    await step(click("Rename"));
    type("Channel handle for a1b2c3", "42");
    await step(click("Link channel"));
    fireEvent.click(screen.getByRole("button", { name: "Remove from profile…" }));
    await step(click("Remove"));
    type("Email address", "n@x.io");
    await step(click("Create user"));
    type("CSV rows", "a@x.io,A,member");
    await step(click("Preview"), 1);
    await step(click("Load"), 1);
    await step(() => type("Search the directory", "mi"), 1);

    const expected = [
      "/role",
      "/deactivate",
      "/invitation",
      "/display",
      "/channels",
      "/api/comms/members/import",
      "/api/comms/members/activity",
      "/api/comms/directory",
    ];
    await waitFor(() => {
      const paths = requests().map((r) => r.url.pathname);
      for (const suffix of expected) expect(paths.some((x) => x.endsWith(suffix))).toBe(true);
      expect(requests().some((r) => r.method === "POST" && r.url.pathname === "/api/comms/members")).toBe(true);
      expect(requests().some((r) => r.method === "DELETE" && r.url.pathname === "/api/comms/members/a1b2c3")).toBe(true);
    });

    const all = requests();
    expect(all.length).toBeGreaterThan(expected.length);
    for (const r of all) expect([r.url.pathname, r.url.searchParams.get("profile")]).toEqual([r.url.pathname, "hr"]);
    // Create and import post the same profile in the body as in the query.
    for (const r of all.filter((x) => x.method === "POST" && x.url.pathname.match(/members(\/import)?$/))) {
      expect(r.body.profile).toBe("hr");
    }
  });

  it("switching profile navigates the Users screen, leaving the session alone", () => {
    view([p("default"), p("hr")]);
    fireEvent.change(screen.getByLabelText("Administering"), {
      target: { value: "default" },
    });
    expect(router.push).toHaveBeenCalledWith("/users?profile=default");
    expect(requests().some((r) => r.url.pathname === "/api/session/profile")).toBe(false);
  });
});

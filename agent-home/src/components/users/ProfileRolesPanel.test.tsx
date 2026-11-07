// @vitest-environment jsdom
/**
 * The per-person "Profiles & roles" panel: it lists only what the server says
 * the actor administers, and every write names the profile it acts in, so the
 * BFF and Python re-check the actor's role there.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProfileRolesPanel } from "@/components/users/ProfileRolesPanel";
import type { Member, PersonProfile } from "@/types";

const PAT = { user_id: "pat", display: "Pat", email: "pat@x.io" };

const line = (over: Partial<PersonProfile>): PersonProfile => ({
  name: "default",
  is_default: false,
  actor_role: "admin",
  enrolled: true,
  role: "member",
  active: true,
  is_owner: false,
  ...over,
});

const PROFILES: PersonProfile[] = [
  line({ name: "default", is_default: true, role: "member" }),
  line({ name: "hr", enrolled: false, role: null, active: null }),
  line({ name: "ops", role: "owner", is_owner: true, actor_role: "owner" }),
  line({ name: "eng", role: "viewer", active: false }),
];

const roster = (members: Partial<Member>[]) => ({
  configured: true,
  members,
  total: members.length,
  limit: 200,
  offset: 0,
});

let fetchMock: ReturnType<typeof vi.fn>;
const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: new URL(String(url), "http://x"),
    method: (init as RequestInit | undefined)?.method ?? "GET",
    body: (init as RequestInit | undefined)?.body
      ? JSON.parse(String((init as RequestInit).body))
      : undefined,
  }));
const writes = () => requests().filter((r) => r.method !== "GET");

describe("ProfileRolesPanel", () => {
  beforeEach(() => {
    fetchMock = vi.fn(async (url: unknown) => {
      const u = new URL(String(url), "http://x");
      if (u.pathname === "/api/comms/people/pat/profiles") {
        return Response.json({ user_id: "pat", profiles: PROFILES });
      }
      if (u.pathname === "/api/comms/members" && u.searchParams.get("limit")) {
        return Response.json(
          roster([{ user_id: "pat", display: "Pat" }, { user_id: "kim", display: "Kim" }]),
        );
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows one line per administered profile and only those", async () => {
    render(<ProfileRolesPanel member={PAT} self={false} />);
    await screen.findByLabelText("Role in default");
    const lines = [...document.querySelectorAll('[data-component="ProfileRoleLine"]')];
    expect(lines.map((l) => l.getAttribute("data-profile"))).toEqual(["default", "hr", "ops", "eng"]);
    expect(lines[1].textContent).toContain("not enrolled");
    // The owner line is read-only: no role select, no Remove.
    expect(lines[2].textContent).toContain("hermes owner transfer");
    expect(lines[2].querySelector("select")).toBeNull();
    expect(lines[3].textContent).toContain("suspended");
    // The read is box-wide: it names no profile.
    expect(requests()[0].url.searchParams.get("profile")).toBeNull();
  });

  it("adds the person to a profile by email, naming that profile twice", async () => {
    const onChanged = vi.fn();
    render(<ProfileRolesPanel member={PAT} self={false} onChanged={onChanged} />);
    fireEvent.change(await screen.findByLabelText("Role to add in hr"), {
      target: { value: "admin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("hr", false));
    const [post] = writes();
    expect([post.method, post.url.pathname, post.url.searchParams.get("profile")]).toEqual([
      "POST",
      "/api/comms/members",
      "hr",
    ]);
    expect(post.body).toEqual({ email: "pat@x.io", profile: "hr", display: "Pat", role: "admin" });
  });

  it("cannot add somebody without an email", async () => {
    render(<ProfileRolesPanel member={{ ...PAT, email: "" }} self={false} />);
    await screen.findByLabelText("Role to add in hr");
    expect(screen.getByRole("button", { name: "Add" })).toHaveProperty("disabled", true);
  });

  it("changes the role in the line's profile", async () => {
    render(<ProfileRolesPanel member={PAT} self={false} />);
    fireEvent.change(await screen.findByLabelText("Role in eng"), { target: { value: "admin" } });
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [put] = writes();
    expect([put.method, put.url.pathname, put.url.searchParams.get("profile"), put.body]).toEqual([
      "PUT",
      "/api/comms/members/pat/role",
      "eng",
      { role: "admin" },
    ]);
  });

  it("removes with the transfer/purge choice from that profile's roster", async () => {
    const onChanged = vi.fn();
    render(<ProfileRolesPanel member={PAT} self onChanged={onChanged} />);
    await screen.findByLabelText("Role in default");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove…" })[0]);
    const dialog = await screen.findByText("Remove yourself from default?");
    expect(dialog).toBeTruthy();
    const heir = screen.getByLabelText("Transfer owned rows to") as HTMLSelectElement;
    // The person being removed never inherits their own rows.
    expect([...heir.options].map((o) => o.value)).toEqual(["kim"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("default", true));
    const del = writes().find((r) => r.method === "DELETE")!;
    expect(del.url.pathname).toBe("/api/comms/members/pat");
    expect(Object.fromEntries(del.url.searchParams)).toEqual({
      strategy: "transfer",
      transfer_to: "kim",
      profile: "default",
    });
    const rosterRead = requests().find((r) => r.method === "GET" && r.url.pathname === "/api/comms/members");
    expect(rosterRead?.url.searchParams.get("profile")).toBe("default");
  });

  it("shows the server's refusal", async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = new URL(String(url), "http://x");
      if (u.pathname.endsWith("/profiles")) return Response.json({ user_id: "pat", profiles: PROFILES });
      if (init?.method === "PUT") {
        return Response.json(
          { detail: "Refusing to demote the last administrator of this profile" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true });
    });
    render(<ProfileRolesPanel member={PAT} self={false} />);
    fireEvent.change(await screen.findByLabelText("Role in default"), { target: { value: "viewer" } });
    expect((await screen.findByRole("alert")).textContent).toContain("last administrator");
  });

  it("says so when the actor administers nothing", async () => {
    fetchMock.mockImplementation(async () => Response.json({ user_id: "pat", profiles: [] }));
    render(<ProfileRolesPanel member={PAT} self={false} />);
    expect(await screen.findByText("You don't administer any profile.")).toBeTruthy();
  });
});

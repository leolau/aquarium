import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MyProfile, Principal, Role } from "@/types";

const state = vi.hoisted(() => ({
  sessionProfile: "default",
  mine: [] as MyProfile[],
  // The role Python's whoami reports per profile — its own principals.
  roles: {} as Record<string, Role>,
  clients: [] as (string | undefined)[],
  reads: [] as { profile: string | undefined; what: string }[],
}));

const principal = (role: Role): Principal => ({
  user_id: "u1",
  display: "U",
  role,
  channels: [],
  is_owner: role === "owner",
});

vi.mock("@/i18n/server", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const settings = (await import("@/i18n/messages/en/settings.json")).default;
  return { getT: async (ns: string) => createTranslator({ settings }, ns) };
});
vi.mock("@/components/MobileShell", () => ({
  MobileShell: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/auth/session", () => ({
  readSession: async () => ({ profile: state.sessionProfile }),
}));
vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async () => principal(state.roles[state.sessionProfile]),
  apiClientForRequest: async (opts: { profile?: string } = {}) => {
    const profile = opts.profile ?? state.sessionProfile;
    state.clients.push(opts.profile);
    return {
      myProfiles: async () => ({ profiles: state.mine }),
      whoami: async () => ({ configured: true, principal: principal(state.roles[profile]) }),
      directory: async () => {
        state.reads.push({ profile, what: "directory" });
        return { configured: true, entries: [], total: 0, profile };
      },
      members: async () => {
        state.reads.push({ profile, what: "members" });
        return { configured: true, members: [], total: 0, limit: 50, offset: 0, profile };
      },
    };
  },
}));

import Page from "./page";

async function usersView(query: Record<string, string>) {
  const tree = (await Page({ searchParams: Promise.resolve(query) })) as ReactElement<{
    children: ReactElement<Record<string, unknown>>;
  }>;
  return tree.props.children.props;
}

describe("/users?profile= (FG-28 C3)", () => {
  beforeEach(() => {
    state.sessionProfile = "default";
    state.roles = { default: "member", hr: "admin", ops: "viewer" };
    state.mine = [
      { name: "default", role: "member", active: true, is_default: true },
      { name: "hr", role: "admin", active: true, is_default: false },
      { name: "ops", role: "viewer", active: true, is_default: false },
    ];
    state.clients = [];
    state.reads = [];
  });

  it("administers a requested profile the account is admin of, loading it there", async () => {
    const props = await usersView({ profile: "hr" });
    expect(props.profile).toBe("hr");
    expect(props.role).toBe("admin");
    expect(state.reads).toEqual([
      { profile: "hr", what: "directory" },
      { profile: "hr", what: "members" },
    ]);
  });

  it("falls back to the session's profile for a profile not administered", async () => {
    for (const profile of ["ops", "finance", ""]) {
      state.reads = [];
      const props = await usersView({ profile });
      expect(props.profile).toBe("default");
      expect(props.role).toBe("member");
      // A member of the session's profile reads the directory, never the roster.
      expect(state.reads).toEqual([{ profile: "default", what: "directory" }]);
    }
  });

  it("offers the switcher only the administered profiles", async () => {
    state.mine.push({ name: "ops2", role: "owner", active: true, is_default: false });
    const props = await usersView({});
    expect((props.administered as { name: string }[]).map((p) => p.name)).toEqual(["hr", "ops2"]);
  });
});

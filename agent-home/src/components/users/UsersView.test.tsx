import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { PAGE_SIZE } from "@/components/users/api";
import { UsersView } from "@/components/users/UsersView";
import type { DirectoryResponse, Member, MembersResponse } from "@/types";

const DIRECTORY: DirectoryResponse = {
  configured: true,
  entries: [
    { user_id: "leo_owner", display: "Leo", role: "owner", channels: ["telegram:1"] },
    { user_id: "a1b2c3", display: "Mia", role: "member", channels: [] },
  ],
  total: 2,
  profile: "acme",
};

const OWNER: Member = {
  user_id: "leo_owner",
  display: "Leo",
  role: "owner",
  email: "leo@x.io",
  active: true,
  enrolled: true,
  channels: ["telegram:1"],
  is_owner: true,
  invitation: null,
};

const MEMBER: Member = {
  user_id: "a1b2c3",
  display: "Mia",
  role: "member",
  email: "mia@x.io",
  active: true,
  enrolled: true,
  channels: [],
  is_owner: false,
  invitation: null,
};

/** A member who has never activated: banned account, open invitation. */
const PENDING: Member = {
  ...MEMBER,
  user_id: "p9p9p9",
  display: "Sam",
  email: "sam@x.io",
  active: false,
  invitation: {
    id: "inv-1",
    user_id: "p9p9p9",
    kind: "activation",
    status: "open",
    expires_at: "2026-08-12T10:35:00+00:00",
    used_at: null,
    revoked_at: null,
    created_by: "leo_owner",
    created_at: "2026-08-12T10:30:00+00:00",
  },
};

function page(members: Member[]): MembersResponse {
  return {
    configured: true,
    members,
    total: members.length,
    limit: PAGE_SIZE,
    offset: 0,
    profile: "acme",
  };
}

describe("UsersView", () => {
  it("shows a viewer the directory only — no roster, no management controls", () => {
    const html = renderToStaticMarkup(
      <UsersView
        role="viewer"
        userId="a1b2c3"
        profile="acme"
        directory={DIRECTORY}
        initialPage={null}
      />,
    );
    expect(html).toContain('data-component="UsersView"');
    expect(html).toContain('data-component="DirectoryPanel"');
    expect(html).toContain("Mia");
    // Management surfaces belong to owner/admin only.
    expect(html).not.toContain('data-component="CreateUserForm"');
    expect(html).not.toContain('data-component="UserRow"');
    expect(html).not.toContain('data-component="CsvImportPanel"');
    // The directory is a name-and-role list; it must not leak account state.
    expect(html).not.toContain("mia@x.io");
  });

  it("gives an admin the create form, roster rows and import panel", () => {
    const html = renderToStaticMarkup(
      <UsersView
        role="admin"
        userId="admin1"
        profile="acme"
        directory={DIRECTORY}
        initialPage={page([OWNER, MEMBER])}
      />,
    );
    expect(html).toContain('data-component="CreateUserForm"');
    expect(html).toContain('data-component="UserRow"');
    expect(html).toContain('data-component="CsvImportPanel"');
    expect(html).toContain('data-component="IdentityActivityPanel"');
    expect(html).toContain("mia@x.io");
    // The administered profile is named, because enrolment is profile-local.
    expect(html).toContain("acme");
  });

  it("never offers to generate, type or relay a password", () => {
    const html = renderToStaticMarkup(
      <UsersView
        role="owner"
        userId="leo_owner"
        profile="acme"
        directory={DIRECTORY}
        initialPage={page([OWNER, MEMBER, PENDING])}
      />,
    );
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Temporary password");
    expect(html).not.toContain("Generate");
    expect(html).not.toContain("Reset password");
    // Activation replaces it.
    expect(html).toContain("activation link");
  });

  it("names the target profile on the create form, picking only among administered ones", () => {
    const render = (administered: string[]) => {
      const html = renderToStaticMarkup(
        <UsersView
          role="owner"
          userId="leo_owner"
          profile="acme"
          administered={administered.map((name) => ({ name, is_default: false, description: "" }))}
          directory={DIRECTORY}
          initialPage={page([OWNER])}
        />,
      );
      return html.slice(html.indexOf('data-component="CreateUserForm"'), html.indexOf("</form>"));
    };
    // One administered profile: no picker, but the form says where it creates.
    const single = render(["acme"]);
    expect(single).not.toContain('name="profile"');
    expect(single).toContain("Creating in <code>acme</code>");
    // Several: a required picker over exactly those, on the viewed one.
    const several = render(["acme", "hr"]);
    const select = several.slice(several.indexOf("<select required"), several.indexOf("</select>", several.indexOf('name="profile"')));
    expect(select).toContain('name="profile"');
    expect([...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual(["acme", "hr"]);
    expect(select).toMatch(/<option value="acme" selected="">/);
  });

  it("marks a pending account as awaiting activation, not as suspended", () => {
    const html = renderToStaticMarkup(
      <UsersView
        role="owner"
        userId="leo_owner"
        profile="acme"
        directory={DIRECTORY}
        initialPage={page([PENDING])}
      />,
    );
    expect(html).toContain("awaiting activation");
  });

  it("shows a reset request as a request, not as a link that was sent", () => {
    // A reset request mints a recovery invitation whose token is returned to
    // nobody — the requester is unauthenticated. "invite open" would tell an
    // admin a live link exists when none was ever handed over.
    const html = renderToStaticMarkup(
      <UsersView
        role="owner"
        userId="leo_owner"
        profile="acme"
        directory={DIRECTORY}
        initialPage={page([
          {
            ...MEMBER,
            invitation: {
              ...PENDING.invitation!,
              user_id: MEMBER.user_id,
              kind: "recovery",
            },
          },
        ])}
      />,
    );
    expect(html).toContain("reset requested");
    expect(html).not.toContain("invite open");
    expect(html).toContain("Send reset link");
  });

  it("keeps the owner row free of role and removal controls", () => {
    const html = renderToStaticMarkup(
      <UsersView
        role="admin"
        userId="admin1"
        profile="acme"
        directory={DIRECTORY}
        initialPage={page([OWNER])}
      />,
    );
    expect(html).toContain("hermes owner transfer");
    expect(html).not.toContain('data-component="UserRoleSelect"');
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

import { AdminProfileSwitcher, usersHref } from "@/components/users/AdminProfileSwitcher";
import type { ProfileSummary } from "@/types";

const p = (name: string): ProfileSummary => ({ name, is_default: name === "default", description: "" });

describe("AdminProfileSwitcher", () => {
  it("is hidden for someone administering fewer than two profiles", () => {
    expect(renderToStaticMarkup(<AdminProfileSwitcher profiles={[]} current="default" />)).toBe("");
    expect(renderToStaticMarkup(<AdminProfileSwitcher profiles={[p("hr")]} current="hr" />)).toBe("");
  });

  it("offers exactly the administered profiles, with the shown one selected", () => {
    const html = renderToStaticMarkup(
      <AdminProfileSwitcher profiles={[p("default"), p("hr")]} current="hr" />,
    );
    expect(html).toContain('data-component="AdminProfileSwitcher"');
    expect(html.match(/<option/g)?.length).toBe(2);
    expect(html).toMatch(/<option value="hr" selected="">hr<\/option>/);
    // Its own id: the header's session switcher can share the page.
    expect(html).not.toContain('id="session-profile"');
  });

  it("puts the choice in the Users URL, keeping the rest of the query", () => {
    expect(usersHref("http://x/users", "hr")).toBe("/users?profile=hr");
    expect(usersHref("http://x/users?profile=hr&q=mi", "default")).toBe("/users?profile=default&q=mi");
    expect(usersHref("http://x/users", "a b")).toBe("/users?profile=a+b");
  });
});

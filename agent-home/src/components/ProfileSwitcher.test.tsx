import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));

import { ProfileSwitcher, switchSessionProfile, urlAfterSwitch } from "@/components/ProfileSwitcher";
import type { ProfileSummary } from "@/types";

const p = (name: string): ProfileSummary => ({ name, is_default: name === "default", description: "" });

describe("ProfileSwitcher", () => {
  it("is hidden for someone with fewer than two active enrolments", () => {
    expect(renderToStaticMarkup(<ProfileSwitcher profiles={[]} current="default" />)).toBe("");
    expect(renderToStaticMarkup(<ProfileSwitcher profiles={[p("hr")]} current="hr" />)).toBe("");
  });

  it("offers exactly the enrolments it is given, with the session's profile selected", () => {
    const html = renderToStaticMarkup(
      <ProfileSwitcher profiles={[p("default"), p("hr")]} current="hr" />,
    );
    expect(html).toContain('data-component="ProfileSwitcher"');
    expect(html.match(/<option/g)?.length).toBe(2);
    expect(html).toMatch(/<option value="hr" selected="">hr<\/option>/);
  });

  it("asks the session switch endpoint and reports its refusal", async () => {
    const fetchMock = vi.fn(async () => Response.json({ detail: "Not enrolled" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await switchSessionProfile("finance")).toEqual({ ok: false, error: "Not enrolled" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/session/profile");
    expect(JSON.parse(String(init.body))).toEqual({ profile: "finance" });
    vi.unstubAllGlobals();
  });

  it("drops what named the old profile's data from the URL", () => {
    expect(urlAfterSwitch("http://x/chat?profile=hr&session=s1&draft=hi")).toBe("/chat?draft=hi");
    expect(urlAfterSwitch("http://x/users")).toBe("/users");
  });
});

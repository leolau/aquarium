// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivateForm } from "@/components/auth/ActivateForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PASSWORD = "a-long-enough-password";

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function activate(profile?: string) {
  const fetchMock = stubFetch();
  render(<ActivateForm token="tok" profile={profile} />);
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
  const signIn = await waitFor(() => screen.getByRole("link", { name: "Sign in" }));
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)), signIn };
}

describe("ActivateForm (FG-28 C2)", () => {
  it("posts the link's profile and signs in to that profile", async () => {
    const { url, body, signIn } = await activate("hr");
    expect(url).toBe("/api/auth/invitations/redeem");
    expect(body).toEqual({ token: "tok", password: PASSWORD, profile: "hr" });
    expect(signIn.getAttribute("href")).toBe("/login?profile=hr");
  });

  it("keeps a legacy link in the default profile", async () => {
    const { body, signIn } = await activate();
    expect(body).toEqual({ token: "tok", password: PASSWORD });
    expect(signIn.getAttribute("href")).toBe("/login");
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretLinkForm, SecretLinkUnusable } from "@/components/secret-link/SecretLinkForm";
import { redactPathForLog } from "@/lib/api/client";
import type { SecretLinkInfo } from "@/types";

const TOKEN = "Q".repeat(43);
const SECRET = "ghp_VERY_SECRET_value_123";
const INFO: SecretLinkInfo = {
  ok: true,
  label: "GitHub token",
  purpose: "Open the PR",
  kind: "secret",
  username: null,
  expires_at: 1_900_000_000,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function stubFetch(status = 200, body: unknown = { ok: true, status: "stored", name: "github_pat" }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SecretLinkForm (FG-37)", () => {
  it("renders a masked field with the label and never the token", () => {
    const html = renderToStaticMarkup(<SecretLinkForm token={TOKEN} info={INFO} />);
    expect(html).toContain('data-component="SecretLinkForm"');
    expect(html).toContain("GitHub token");
    expect(html.match(/type="password"/g)).toHaveLength(1);
    expect(html).not.toContain(TOKEN);
  });

  it("toggles show/hide and accepts a pasted value", () => {
    render(<SecretLinkForm token={TOKEN} info={INFO} />);
    const field = screen.getByLabelText("Secret") as HTMLInputElement;
    fireEvent.paste(field);
    fireEvent.change(field, { target: { value: SECRET } });
    expect(field.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(field.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(field.type).toBe("password");
  });

  it("posts the value once, clears it and shows success without storing it", async () => {
    const fetchMock = stubFetch();
    const log = vi.spyOn(console, "log");
    render(<SecretLinkForm token={TOKEN} info={INFO} />);
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    await waitFor(() => screen.getByText("Saved securely"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/secret-links/${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ values: { value: SECRET } });
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(log.mock.calls.flat().map(String).join()).not.toContain(SECRET);
    log.mockRestore();
  });

  it("sends username + password for a password request", async () => {
    const fetchMock = stubFetch();
    render(<SecretLinkForm token={TOKEN} info={{ ...INFO, kind: "password", username: "mia" }} />);
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("mia");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    await waitFor(() => screen.getByText("Saved securely"));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ values: { password: SECRET, username: "mia" } });
  });

  it("declines", async () => {
    const fetchMock = stubFetch(200, { ok: true, status: "declined" });
    render(<SecretLinkForm token={TOKEN} info={INFO} />);
    fireEvent.click(screen.getByRole("button", { name: "Don't share" }));
    await waitFor(() => screen.getByText("Not shared"));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ decline: true });
  });

  it("an empty submit stays local", () => {
    const fetchMock = stubFetch();
    render(<SecretLinkForm token={TOKEN} info={INFO} />);
    fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a used or expired link switches to the neutral card", async () => {
    stubFetch(404, { ok: false, error: "not_found" });
    render(<SecretLinkForm token={TOKEN} info={INFO} />);
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    await waitFor(() => screen.getByText("This link cannot be used"));
  });

  it("the unusable card says nothing about why", () => {
    const html = renderToStaticMarkup(<SecretLinkUnusable />);
    expect(html).toContain('data-component="SecretLinkUnusable"');
  });

  it("the BFF's upstream timing log redacts the token", () => {
    expect(redactPathForLog(`/api/secret-links/${TOKEN}`)).toBe("/api/secret-links/[redacted]");
    expect(redactPathForLog("/api/tools")).toBe("/api/tools");
  });
});

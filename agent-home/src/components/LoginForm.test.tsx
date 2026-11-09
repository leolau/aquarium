// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));

import { LoginForm } from "./LoginForm";

afterEach(() => {
  cleanup();
  replace.mockReset();
  vi.unstubAllGlobals();
});

const PROVIDERS = [
  { name: "supabase", display_name: "Email & Password (Supabase)", supports_password: true },
  { name: "basic", display_name: "Username & Password", supports_password: true },
];

describe("LoginForm identity", () => {
  it("shows one Email or username field: no tabs and no provider choice", () => {
    const { container } = render(<LoginForm providers={PROVIDERS} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    const field = screen.getByLabelText("Email or username") as HTMLInputElement;
    expect(field.type).toBe("text");
    expect(field.autocomplete).toBe("username");
    expect(container.querySelectorAll("input")).toHaveLength(2);
  });

  it("sends the identifier without a provider (the server picks it), plus the profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginForm providers={PROVIDERS} profile="hr" />);
    fireEvent.change(screen.getByLabelText("Email or username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-123456789012" } });
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      username: "admin",
      password: "pw-123456789012",
      profile: "hr",
    });
  });

  it("says the email/username or password is wrong, and nothing about providers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: "login_failed", detail: "Invalid credentials or provider." }, { status: 401 }),
      ),
    );
    render(<LoginForm providers={PROVIDERS} />);
    fireEvent.change(screen.getByLabelText("Email or username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    await act(async () => {
      fireEvent.submit(document.querySelector("form")!);
    });
    expect(screen.getByText("Wrong email/username or password.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  });

  it("keeps the no-provider warning and a disabled Sign in", () => {
    render(<LoginForm providers={[]} />);
    expect(screen.getByText(/No password provider is configured/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("LoginForm two-factor step", () => {
  it("asks for a code after the password, then sends both", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: false, two_factor_required: true, provider: "supabase" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <LoginForm providers={[{ name: "supabase", display_name: "Email", supports_password: true }]} />,
    );
    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[0], { target: { value: "o@x.io" } });
    fireEvent.change(inputs[1], { target: { value: "pw-123456789012" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(container.querySelector('[data-component="LoginCodeForm"]')).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.change(container.querySelector("input")!, { target: { value: "123456" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      username: "o@x.io",
      password: "pw-123456789012",
    });
    const second = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(second).toEqual({
      provider: "supabase",
      username: "o@x.io",
      password: "pw-123456789012",
      code: "123456",
    });
    expect(replace).toHaveBeenCalledWith("/");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

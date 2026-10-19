// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));

import { LoginForm } from "./LoginForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoginForm two-factor step", () => {
  it("asks for a code after the password, then sends both", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: false, two_factor_required: true }))
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

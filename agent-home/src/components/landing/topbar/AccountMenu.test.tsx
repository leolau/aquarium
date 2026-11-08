// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "./AccountMenu";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

afterEach(cleanup);

describe("AccountMenu", () => {
  it("shows the initial and opens a menu with account, settings and sign-out", () => {
    render(<AccountMenu name="yan" />);
    const btn = screen.getByRole("button", { name: "Account: yan" });
    expect(btn.textContent).toBe("Y");
    fireEvent.click(btn);
    expect(screen.getByRole("menuitem", { name: "Account" }).getAttribute("href")).toBe("/settings/account");
    expect(screen.getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    expect(screen.getByRole("menu").querySelector('[data-component="LogoutButton"], button')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

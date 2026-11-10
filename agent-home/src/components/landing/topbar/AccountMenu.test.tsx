// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "./AccountMenu";

const replaceLocation = vi.fn();
vi.mock("@/lib/replace-location", () => ({ replaceLocation: (href: string) => replaceLocation(href) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AccountMenu", () => {
  it("shows the initial and opens a menu with account, settings and sign-out", () => {
    render(<AccountMenu name="yan" />);
    const btn = screen.getByRole("button", { name: "Account: yan" });
    expect(btn.querySelector("span")!.textContent).toBe("Y");
    fireEvent.click(btn);
    expect(screen.getByRole("menuitem", { name: "Account" }).getAttribute("href")).toBe("/settings/account");
    expect(screen.getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    expect(screen.getByRole("menu").querySelector('[data-component="LogoutButton"], button')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a pointer press on the sign-out confirmation signs out instead of closing the menu", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    render(<AccountMenu name="yan" />);
    fireEvent.click(screen.getByRole("button", { name: "Account: yan" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Sign out" });
    fireEvent.mouseDown(confirm);
    fireEvent.touchStart(confirm);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(replaceLocation).toHaveBeenCalledWith("/login");
  });

  it("shows the name and current role on the trigger and every enrolled role in the menu", () => {
    render(
      <AccountMenu
        name="Yan"
        role="admin"
        currentProfile="default"
        roles={[
          { profile: "default", role: "admin" },
          { profile: "sales", role: "viewer" },
        ]}
      />,
    );
    const btn = screen.getByRole("button", { name: "Account: Yan, Admin" });
    expect(within(btn).getByTestId("account-identity").textContent).toBe("YanAdmin");
    fireEvent.click(btn);
    expect(screen.getByTestId("account-summary").textContent).toContain("Signed in as Yan");
    expect(screen.getByTestId("account-summary").textContent).toContain("Admin");
    const rows = within(screen.getByTestId("account-roles")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["default · currentAdmin", "salesViewer"]);
  });

  it("shows only the current role when the account is in one profile", () => {
    render(<AccountMenu name="Yan" role="member" currentProfile="default" roles={[{ profile: "default", role: "member" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Yan, Member" }));
    expect(screen.getByTestId("account-summary").textContent).toContain("Member");
    expect(screen.queryByTestId("account-roles")).toBeNull();
  });
});

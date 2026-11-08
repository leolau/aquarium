// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/projects/missing" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  usePathname: () => nav.pathname,
}));

import ErrorPage from "@/app/error";
import { ErrorState } from "@/components/ui/ErrorState";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ErrorState", () => {
  it("404: brand illustration, the missing path, Go back and Home, no Retry or details", () => {
    const { container } = render(<ErrorState kind="notFound" />);
    expect(container.querySelector('img[src^="/brand/illustrations/"]')).not.toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("This fish swam off the map");
    expect(container.textContent).toContain("/projects/missing");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });

  it("Go back goes to the logical parent, never browser history", () => {
    render(<ErrorState kind="notFound" />);
    expect(screen.getByRole("link", { name: "Go back" }).getAttribute("href")).toBe("/projects");
  });

  it("signed out: Sign in instead of Home, and no jump links", () => {
    render(<ErrorState kind="notFound" signedOut />);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("error page: Retry locks while it resets and the details stay collapsed", async () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("upstream 502"), { digest: "abc123" });
    const { container } = render(<ErrorPage error={err} reset={reset} />);
    expect(container.querySelector('[data-component="MobileShell"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    const retry = screen.getByRole("button", { name: "Retry" });
    await act(async () => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("upstream 502");
    expect(details.textContent).toContain("abc123");
    expect(details.textContent).toContain("Copy details");
  });
});

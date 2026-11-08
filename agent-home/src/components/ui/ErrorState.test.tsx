// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import ErrorPage from "@/app/error";
import { ErrorState } from "@/components/ui/ErrorState";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ErrorState", () => {
  it("404: brand illustration, Go back and Home, no Retry or details", () => {
    const { container } = render(<ErrorState kind="notFound" />);
    expect(container.querySelector('img[src^="/brand/illustrations/"]')).not.toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("We couldn't find that page");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });

  it("Go back leaves via history, or goes home when there is none", () => {
    render(<ErrorState kind="notFound" />);
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(router.back.mock.calls.length + router.push.mock.calls.length).toBe(1);
  });

  it("error page: Retry calls reset and the details stay collapsed", () => {
    const reset = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("upstream 502"), { digest: "abc123" });
    const { container } = render(<ErrorPage error={err} reset={reset} />);
    expect(container.querySelector('[data-component="MobileShell"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("upstream 502");
    expect(details.textContent).toContain("abc123");
  });
});

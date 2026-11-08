// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

import { SetupOwnerForm, hashCarriesSetupLink } from "@/components/auth/SetupOwnerForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("setup step rail", () => {
  it("only a fragment with a setup token counts as a new link", () => {
    expect(hashCarriesSetupLink("#token=abc")).toBe(true);
    expect(hashCarriesSetupLink("#s1")).toBe(false);
    expect(hashCarriesSetupLink("")).toBe(false);
  });

  it("scrolls in place instead of changing the fragment, so the form is kept", async () => {
    window.history.replaceState(null, "", "/setup#token=abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, steps: true }), { status: 200 })),
    );
    Element.prototype.scrollIntoView = vi.fn();
    render(<SetupOwnerForm />);
    await act(async () => {});
    const rail = screen.getByRole("navigation");
    const link = rail.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe("");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

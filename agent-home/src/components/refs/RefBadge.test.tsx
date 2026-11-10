// @vitest-environment jsdom
/** The ref chip shows the ref, copies it on tap, and never navigates. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RefBadge } from "./RefBadge";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RefBadge", () => {
  it("renders nothing without a ref", () => {
    const { container } = render(<RefBadge value={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("copies the ref and says so, without following the row it sits in", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onRowClick = vi.fn();
    const { getByRole } = render(
      <div onClick={onRowClick}>
        <RefBadge value="P12" />
      </div>,
    );
    const badge = getByRole("button", { name: "Copy reference P12" });
    expect(badge.textContent).toBe("P12");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      badge.dispatchEvent(event);
    });
    expect(writeText).toHaveBeenCalledWith("P12");
    expect(event.defaultPrevented).toBe(true);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(badge.textContent).toBe("Copied");
  });

  it("stays on the ref when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    const { getByRole } = render(<RefBadge value="T345" />);
    await act(async () => {
      fireEvent.click(getByRole("button"));
    });
    expect(getByRole("button").textContent).toBe("T345");
  });
});

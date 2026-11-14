// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Sheet } from "./Sheet";

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <button type="button">Background</button>
      {open ? (
        <Sheet title="Panel" onClose={() => setOpen(false)}>
          <button type="button">Inside</button>
        </Sheet>
      ) : null}
    </div>
  );
}

const flushFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe("Sheet", () => {
  it("renders on body, keeps Tab inside and returns focus to the opener", async () => {
    const { container } = render(<Harness />);
    const opener = screen.getByText("Open sheet");
    opener.focus();
    fireEvent.click(opener);
    await flushFrame();

    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);

    const close = screen.getByLabelText("Close");
    const inside = screen.getByText("Inside");
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inside);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open sheet"));
    await flushFrame();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

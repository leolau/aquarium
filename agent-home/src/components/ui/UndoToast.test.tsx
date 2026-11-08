// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UNDO_MS, useUndoToast } from "./UndoToast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness({ undo }: { undo: () => unknown }) {
  const { show, toast } = useUndoToast();
  return (
    <>
      <button onClick={() => show("Archived", undo)}>do</button>
      {toast}
    </>
  );
}

describe("useUndoToast", () => {
  it("runs Undo once even when pressed twice", async () => {
    const undo = vi.fn(() => new Promise((r) => setTimeout(r, 10)));
    render(<Harness undo={undo} />);
    fireEvent.click(screen.getByText("do"));
    const btn = screen.getByRole("button", { name: /undo/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Archived")).toBeNull();
  });

  it("disappears after six seconds", () => {
    vi.useFakeTimers();
    render(<Harness undo={() => {}} />);
    fireEvent.click(screen.getByText("do"));
    expect(screen.getByText("Archived")).toBeTruthy();
    act(() => vi.advanceTimersByTime(UNDO_MS + 10));
    expect(screen.queryByText("Archived")).toBeNull();
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useConfirm, type AskOptions } from "./useConfirm";

afterEach(cleanup);

const OPTS: AskOptions = { title: "Stop run?", body: "Work stops now.", confirmLabel: "Stop" };

function Harness({ onResult }: { onResult: (v: unknown) => void }) {
  const { ask, askText, dialog } = useConfirm();
  return (
    <>
      <button type="button" onClick={() => void ask(OPTS).then(onResult)}>ask</button>
      <button type="button" onClick={() => void askText({ ...OPTS, label: "Slug" }).then(onResult)}>
        text
      </button>
      {dialog}
    </>
  );
}

describe("useConfirm", () => {
  it("resolves true on confirm and false on cancel, with no native dialog", async () => {
    const results: unknown[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByText("ask"));
    expect(screen.getByRole("dialog").textContent).toContain("Work stops now.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    fireEvent.click(screen.getByText("ask"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(results).toEqual([true, false]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a second ask while one is open resolves cancelled instead of stacking", async () => {
    const results: unknown[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByText("ask"));
    await act(async () => fireEvent.click(screen.getByText("ask")));
    expect(results).toEqual([false]);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("askText resolves the trimmed answer and blocks an empty one", async () => {
    const results: unknown[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByText("text"));
    const confirm = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "  acme  " } });
    await act(async () => fireEvent.click(confirm));
    expect(results).toEqual(["acme"]);
  });
});

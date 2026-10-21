// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionButton } from "@/components/ui/ActionButton";
import { useAction } from "@/lib/use-action";

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ActionButton", () => {
  it("calls the server once for a fast double-click and shows it is working", async () => {
    const d = deferred();
    const action = vi.fn(() => d.promise);
    render(<ActionButton onAction={action} busyLabel="Saving…">Save</ActionButton>);
    const button = screen.getByRole("button");

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(action).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe("Saving…");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");

    await act(async () => d.resolve());
    expect(button.textContent).toBe("Save");
    expect(button.hasAttribute("disabled")).toBe(false);

    fireEvent.click(button);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("re-enables after the work fails so the person can try again", async () => {
    const d = deferred();
    const action = vi.fn(() => d.promise.catch(() => undefined));
    render(<ActionButton onAction={action}>Test</ActionButton>);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button.textContent).toBe("Working…");
    await act(async () => d.reject(new Error("boom")));
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("is busy when told so from outside (a form's submit)", () => {
    render(<ActionButton type="submit" busy busyLabel="Sending…">Send</ActionButton>);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("Sending…");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("useAction in a form", () => {
  function Form({ submit }: { submit: () => Promise<void> }) {
    const { run, pending } = useAction(submit);
    return (
      <form onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input aria-label="name" />
        <ActionButton type="submit" busy={pending}>Send</ActionButton>
      </form>
    );
  }

  it("sends once when Enter is pressed twice quickly", async () => {
    const d = deferred();
    const submit = vi.fn(() => d.promise);
    const { container } = render(<Form submit={submit} />);
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
    await act(async () => d.resolve());
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);
  });
});
